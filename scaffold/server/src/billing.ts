import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';
import { collections, type BillingStatus } from './db.js';
import { emitWorkspaceEvent } from './events.js';
import { getRedis } from './redis.js';
import { verifyWebhookSignature } from './webhook-auth.js';

export function canWorkspaceSend(status: BillingStatus): boolean {
  return status === 'none' || status === 'active' || status === 'past_due';
}

export async function getWorkspaceBilling(workspace: string): Promise<{
  status: BillingStatus;
  seats: number;
  can_send: boolean;
  nextActionUrl?: string | null;
  cancelAtPeriodEnd?: boolean;
  lastError?: string | null;
}> {
  const { billing } = await collections();
  const doc = await billing.findOne({ workspace });
  if (!doc) {
    return { status: 'none', seats: 1, can_send: true, nextActionUrl: null, cancelAtPeriodEnd: false, lastError: null };
  }
  return {
    status: doc.status,
    seats: doc.seats,
    can_send: canWorkspaceSend(doc.status),
    nextActionUrl: doc.nextActionUrl ?? null,
    cancelAtPeriodEnd: doc.cancelAtPeriodEnd ?? false,
    lastError: doc.lastError ?? null,
  };
}

async function withWorkspaceBillingLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const redis = getRedis();
  const lockKey = `lock:billing:${workspace}`;
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + 12_000;

  while (Date.now() < deadline) {
    const ok = await redis.set(lockKey, token, 'PX', 15_000, 'NX');
    if (ok === 'OK') {
      try {
        return await fn();
      } finally {
        const cur = await redis.get(lockKey);
        if (cur === token) await redis.del(lockKey);
      }
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('billing_lock_timeout');
}

async function payboxFetch(path: string, init?: RequestInit & { idempotencyKey?: string }) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.paybox.secretKey}`,
    'content-type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.idempotencyKey) {
    headers['idempotency-key'] = init.idempotencyKey;
  }
  return fetch(`${config.paybox.url}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(8000),
  });
}

function mapPayboxSubStatus(status: string | undefined): BillingStatus {
  if (status === 'active' || status === 'past_due' || status === 'canceled' || status === 'incomplete') {
    return status;
  }
  return 'incomplete';
}

export async function subscribeWorkspace(params: {
  workspace: string;
  seats: number;
  token: string;
  name?: string;
  email?: string;
}): Promise<{
  ok: boolean;
  statusCode: 200 | 402;
  status: BillingStatus;
  seats: number;
  can_send: boolean;
  nextActionUrl?: string | null;
  error?: string | null;
}> {
  const { workspace, seats, token, name, email } = params;
  return withWorkspaceBillingLock(workspace, async () => {
    const { billing } = await collections();
    let doc = await billing.findOne({ workspace });

    // If already active, do not create a duplicate subscription on concurrent calls
    if (doc?.subscriptionId && doc.status === 'active') {
      return {
        ok: true,
        statusCode: 200,
        status: doc.status,
        seats: doc.seats,
        can_send: true,
        nextActionUrl: null,
        error: null,
      };
    }

    let customerId = doc?.customerId;
    if (!customerId) {
      const custRes = await payboxFetch('/v1/customers', {
        method: 'POST',
        idempotencyKey: `cust_${workspace}`,
        body: JSON.stringify({
          name: name || workspace,
          email: email || `billing@${workspace}.test`,
          metadata: { workspace },
        }),
      });
      if (!custRes.ok) {
        const txt = await custRes.text();
        throw new Error(`Paybox customer error ${custRes.status}: ${txt}`);
      }
      const cust = (await custRes.json()) as { id: string };
      customerId = cust.id;
    }

    const pmRes = await payboxFetch(`/v1/customers/${customerId}/payment_method`, {
      method: 'POST',
      idempotencyKey: `pm_${workspace}_${token}`,
      body: JSON.stringify({ token }),
    });
    if (!pmRes.ok) {
      const errBody = (await pmRes.json().catch(() => ({}))) as { error?: { message?: string } };
      return {
        ok: false,
        statusCode: 402,
        status: doc?.status ?? 'none',
        seats: doc?.seats ?? seats,
        can_send: canWorkspaceSend(doc?.status ?? 'none'),
        error: errBody?.error?.message || 'payment_method_failed',
      };
    }

    // Create subscription (or update if an incomplete one already exists? Paybox creates new sub if none)
    const subKey = `sub_${workspace}_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
    const subRes = await payboxFetch('/v1/subscriptions', {
      method: 'POST',
      idempotencyKey: subKey,
      body: JSON.stringify({
        customer: customerId,
        price: 'price_seat_monthly',
        quantity: seats,
      }),
    });
    const sub = (await subRes.json().catch(() => ({}))) as any;
    if (!subRes.ok) {
      return {
        ok: false,
        statusCode: 402,
        status: 'incomplete',
        seats,
        can_send: false,
        error: sub?.error?.message || 'subscription_failed',
      };
    }

    const nextStatus = mapPayboxSubStatus(sub.status);
    const payment = sub.latest_invoice?.payment;
    const nextActionUrl =
      payment?.status === 'requires_action' ? (payment.next_action?.url as string | null) ?? null : null;
    const lastError = payment?.failure_reason || payment?.last_payment_error || null;

    await billing.updateOne(
      { workspace },
      {
        $set: {
          workspace,
          customerId,
          subscriptionId: sub.id,
          status: nextStatus,
          seats: Number(sub.quantity || seats),
          cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
          nextActionUrl,
          lastError,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    await emitWorkspaceEvent(workspace, 'billing.updated', {
      status: nextStatus,
      seats: Number(sub.quantity || seats),
      can_send: canWorkspaceSend(nextStatus),
    });

    const isActive = nextStatus === 'active';
    return {
      ok: isActive,
      statusCode: isActive ? 200 : 402,
      status: nextStatus,
      seats: Number(sub.quantity || seats),
      can_send: canWorkspaceSend(nextStatus),
      nextActionUrl,
      error: isActive ? null : lastError || (nextActionUrl ? 'authentication_required' : 'payment_failed'),
    };
  });
}

export async function updateWorkspaceSeats(params: {
  workspace: string;
  seats: number;
}): Promise<{
  ok: boolean;
  statusCode: 200 | 402;
  status: BillingStatus;
  seats: number;
  creditNotice?: string | null;
  error?: string | null;
}> {
  const { workspace, seats } = params;
  return withWorkspaceBillingLock(workspace, async () => {
    const { billing } = await collections();
    const doc = await billing.findOne({ workspace });
    if (!doc?.subscriptionId) {
      return { ok: false, statusCode: 402, status: doc?.status ?? 'none', seats: doc?.seats ?? 1, error: 'no_subscription' };
    }

    const prevSeats = doc.seats;
    const res = await payboxFetch(`/v1/subscriptions/${doc.subscriptionId}`, {
      method: 'POST',
      idempotencyKey: `seats_${doc.subscriptionId}_${seats}_${Date.now()}`,
      body: JSON.stringify({ quantity: seats }),
    });
    const body = (await res.json().catch(() => ({}))) as any;

    if (!res.ok) {
      return {
        ok: false,
        statusCode: 402,
        status: doc.status,
        seats: prevSeats,
        error: body?.error?.message || 'seat_update_failed',
      };
    }

    const nextStatus = mapPayboxSubStatus(body.status || doc.status);
    const nextSeats = Number(body.quantity ?? seats);
    await billing.updateOne(
      { workspace },
      { $set: { seats: nextSeats, status: nextStatus, updatedAt: new Date() } }
    );

    await emitWorkspaceEvent(workspace, 'billing.updated', {
      status: nextStatus,
      seats: nextSeats,
      can_send: canWorkspaceSend(nextStatus),
    });

    const creditNotice =
      nextSeats < prevSeats
        ? `Reduced from ${prevSeats} to ${nextSeats} seats. Unused time is credited to your next invoice.`
        : null;

    return { ok: true, statusCode: 200, status: nextStatus, seats: nextSeats, creditNotice };
  });
}

export async function cancelWorkspaceSubscription(workspace: string): Promise<{ ok: boolean; status: BillingStatus }> {
  return withWorkspaceBillingLock(workspace, async () => {
    const { billing } = await collections();
    const doc = await billing.findOne({ workspace });
    if (!doc?.subscriptionId) return { ok: false, status: 'none' };

    const res = await payboxFetch(`/v1/subscriptions/${doc.subscriptionId}`, { method: 'DELETE' });
    const body = (await res.json().catch(() => ({}))) as any;
    const nextStatus = mapPayboxSubStatus(body.status || 'canceled');

    await billing.updateOne(
      { workspace },
      { $set: { status: nextStatus, updatedAt: new Date() } }
    );
    await emitWorkspaceEvent(workspace, 'billing.updated', {
      status: nextStatus,
      seats: doc.seats,
      can_send: canWorkspaceSend(nextStatus),
    });
    return { ok: res.ok, status: nextStatus };
  });
}

export async function handlePayboxWebhook(req: Request, res: Response): Promise<void> {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const sigHeader = req.headers['x-paybox-signature'];
  if (!verifyWebhookSignature(typeof sigHeader === 'string' ? sigHeader : undefined, rawBody, config.paybox.webhookSecret)) {
    res.status(401).json({ error: 'invalid_signature' });
    return;
  }

  let event: any;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid_json' });
    return;
  }

  const obj = event?.data?.object;
  if (!obj || typeof obj !== 'object') {
    res.status(200).json({ ok: true });
    return;
  }

  const subscriptionId =
    typeof obj.id === 'string' && obj.id.startsWith('sub_')
      ? obj.id
      : typeof obj.subscription === 'string'
        ? obj.subscription
        : '';

  if (!subscriptionId) {
    res.status(200).json({ ok: true });
    return;
  }

  // Always fetch live subscription from Paybox (events are a photograph of the past)
  const subRes = await payboxFetch(`/v1/subscriptions/${subscriptionId}`);
  if (!subRes.ok) {
    res.status(200).json({ ok: true, ignored: 'subscription_not_found' });
    return;
  }
  const sub = (await subRes.json()) as any;
  const { billing } = await collections();

  let doc = await billing.findOne({ subscriptionId });
  let workspace = doc?.workspace;

  if (!workspace && sub.customer) {
    const custRes = await payboxFetch(`/v1/customers/${sub.customer}`);
    if (custRes.ok) {
      const cust = (await custRes.json()) as any;
      workspace = cust?.metadata?.workspace;
    }
  }

  if (!workspace) {
    res.status(200).json({ ok: true, ignored: 'unknown_workspace' });
    return;
  }

  const nextStatus = mapPayboxSubStatus(sub.status);
  const nextSeats = Number(sub.quantity ?? doc?.seats ?? 1);
  const payment = sub.latest_invoice?.payment;
  const nextActionUrl =
    payment?.status === 'requires_action' ? (payment.next_action?.url as string | null) ?? null : null;

  await billing.updateOne(
    { workspace },
    {
      $set: {
        workspace,
        customerId: sub.customer || doc?.customerId,
        subscriptionId,
        status: nextStatus,
        seats: nextSeats,
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        nextActionUrl,
        lastError: nextStatus === 'active' ? null : doc?.lastError ?? null,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  await emitWorkspaceEvent(workspace, 'billing.updated', {
    status: nextStatus,
    seats: nextSeats,
    can_send: canWorkspaceSend(nextStatus),
  });

  res.status(200).json({ ok: true });
}

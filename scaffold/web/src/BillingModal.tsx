import { useEffect, useState } from 'react';

interface BillingState {
  status: 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';
  seats: number;
  can_send: boolean;
  nextActionUrl?: string | null;
  cancelAtPeriodEnd?: boolean;
  lastError?: string | null;
  payboxUrl: string;
  publishableKey: string;
  pricePerSeatCents: number;
}

const STATUS_COPY: Record<BillingState['status'], string> = {
  none: 'Free trial — you can send messages. Subscribe anytime for $12/seat/month.',
  incomplete: 'Payment incomplete — finish bank approval or retry with a valid card to enable sending.',
  active: 'Active subscription — all features enabled.',
  past_due: 'Payment past due — Paybox is retrying renewal. Sending remains enabled during the grace period.',
  canceled: 'Subscription canceled — inbox is read-only. Re-subscribe to send replies.',
};

export function BillingModal({
  workspace,
  onClose,
}: {
  workspace: string;
  onClose: () => void;
}) {
  const [bill, setBill] = useState<BillingState | null>(null);
  const [seats, setSeats] = useState(2);
  const [cardNumber, setCardNumber] = useState('4242 4242 4242 4242');
  const [expMonth, setExpMonth] = useState('12');
  const [expYear, setExpYear] = useState('2028');
  const [cvc, setCvc] = useState('123');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch(`/api/billing?workspace=${encodeURIComponent(workspace)}`);
    if (res.ok) {
      const d: BillingState = await res.json();
      setBill(d);
      setSeats(d.seats || 1);
    }
  };

  useEffect(() => {
    void load();
  }, [workspace]);

  async function handleSubscribe() {
    if (!bill) return;
    setBusy(true);
    setMsg(null);
    try {
      // Card details go directly from browser -> Paybox (never to Switchboard server)
      const tokRes = await fetch(`${bill.payboxUrl}/v1/tokens`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bill.publishableKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          card: {
            number: cardNumber.replace(/\s+/g, ''),
            exp_month: Number(expMonth),
            exp_year: Number(expYear),
            cvc,
          },
        }),
      });
      const tokData = await tokRes.json();
      if (!tokRes.ok || !tokData.id) {
        setMsg(tokData?.error?.message || 'Card tokenization failed');
        return;
      }

      const subRes = await fetch('/api/billing/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, seats, token: tokData.id }),
      });
      const subData = await subRes.json();
      if (!subRes.ok) {
        setMsg(subData.error || 'Subscription payment did not complete');
      } else {
        setMsg('Subscription is active!');
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleUpdateSeats() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/billing/seats', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace, seats }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error || 'Could not update seats (payment failed)');
      } else {
        setMsg(data.creditNotice || `Updated to ${data.seats} seats.`);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel() {
    setBusy(true);
    setMsg(null);
    try {
      await fetch('/api/billing/cancel', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace }),
      });
      setMsg('Subscription canceled.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
    >
      <div className="login-card" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Workspace Billing · {workspace}</h2>
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {!bill ? (
          <p>Loading billing…</p>
        ) : (
          <>
            <div className={`badge ${bill.can_send ? 'ok' : 'err'}`} style={{ display: 'inline-block', marginBottom: 10 }}>
              Status: {bill.status.toUpperCase()} · {bill.seats} seat(s)
            </div>
            <p style={{ fontSize: 13, marginBottom: 14 }}>{STATUS_COPY[bill.status]}</p>

            {bill.nextActionUrl && (
              <div style={{ marginBottom: 14, padding: 10, background: 'var(--amber-soft)', borderRadius: 8, fontSize: 13 }}>
                Bank approval required:{' '}
                <a href={bill.nextActionUrl} target="_blank" rel="noreferrer">
                  Approve payment at bank
                </a>
              </div>
            )}

            {msg && (
              <div style={{ marginBottom: 12, padding: 8, background: 'var(--accent-soft)', borderRadius: 6, fontSize: 13 }}>
                {msg}
              </div>
            )}

            <div style={{ display: 'grid', gap: 10, marginBottom: 16 }}>
              <label style={{ fontSize: 12, fontWeight: 600 }}>
                Seats ($12/seat/mo)
                <input
                  type="number"
                  min={1}
                  value={seats}
                  onChange={(e) => setSeats(Math.max(1, Number(e.target.value)))}
                  style={{ width: '100%', padding: 7, marginTop: 4, border: '1px solid var(--border)', borderRadius: 6 }}
                />
              </label>

              {bill.status === 'active' ? (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" disabled={busy} onClick={handleUpdateSeats}>
                    Update Seats
                  </button>
                  <button className="btn" disabled={busy} onClick={handleCancel}>
                    Cancel Subscription
                  </button>
                </div>
              ) : (
                <>
                  <label style={{ fontSize: 12, fontWeight: 600 }}>
                    Card Number (tokenized directly with Paybox)
                    <input
                      value={cardNumber}
                      onChange={(e) => setCardNumber(e.target.value)}
                      style={{ width: '100%', padding: 7, marginTop: 4, border: '1px solid var(--border)', borderRadius: 6 }}
                    />
                  </label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    <input value={expMonth} onChange={(e) => setExpMonth(e.target.value)} placeholder="MM" style={{ width: '100%', minWidth: 0, padding: 7, border: '1px solid var(--border)', borderRadius: 6 }} />
                    <input value={expYear} onChange={(e) => setExpYear(e.target.value)} placeholder="YYYY" style={{ width: '100%', minWidth: 0, padding: 7, border: '1px solid var(--border)', borderRadius: 6 }} />
                    <input value={cvc} onChange={(e) => setCvc(e.target.value)} placeholder="CVC" style={{ width: '100%', minWidth: 0, padding: 7, border: '1px solid var(--border)', borderRadius: 6 }} />
                  </div>
                  <button className="btn btn-primary" disabled={busy} onClick={handleSubscribe}>
                    {busy ? 'Processing…' : `Subscribe ($${seats * 12}/mo)`}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

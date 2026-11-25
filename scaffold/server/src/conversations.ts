import { collections } from './db.js';
import { emitWorkspaceEvent } from './events.js';

export async function claimConversation(params: {
  workspace: string;
  contact: string;
  agent: string;
}): Promise<{ ok: true; assignee: string } | { ok: false; status: 409; assignee: string | null }> {
  const { workspace, contact, agent } = params;
  const { conversations } = await collections();
  const now = new Date();

  try {
    const doc = await conversations.findOneAndUpdate(
      {
        workspace,
        contact,
        $or: [{ assignee: null }, { assignee: agent }],
      },
      {
        $set: { assignee: agent, updatedAt: now },
        $setOnInsert: {
          workspace,
          contact,
          status: 'open',
          lastMessageAt: now,
          lastMessageText: '',
        },
      },
      { upsert: true, returnDocument: 'after' }
    );

    if (doc) {
      await emitWorkspaceEvent(workspace, 'conversation.assigned', {
        contact,
        assignee: agent,
      });
      return { ok: true, assignee: agent };
    }
  } catch (err: any) {
    if (err?.code !== 11000) throw err;
  }

  const current = await conversations.findOne({ workspace, contact });
  return { ok: false, status: 409, assignee: current?.assignee ?? null };
}

export async function releaseConversation(params: {
  workspace: string;
  contact: string;
}): Promise<void> {
  const { workspace, contact } = params;
  const { conversations } = await collections();
  await conversations.updateOne(
    { workspace, contact },
    { $set: { assignee: null, updatedAt: new Date() } }
  );
  await emitWorkspaceEvent(workspace, 'conversation.assigned', {
    contact,
    assignee: null,
  });
}

export async function setConversationStatus(params: {
  workspace: string;
  contact: string;
  status: 'open' | 'closed';
}): Promise<void> {
  const { workspace, contact, status } = params;
  const { conversations } = await collections();
  await conversations.updateOne(
    { workspace, contact },
    { $set: { status, updatedAt: new Date() } }
  );
  await emitWorkspaceEvent(workspace, 'conversation.status', {
    contact,
    status,
  });
}

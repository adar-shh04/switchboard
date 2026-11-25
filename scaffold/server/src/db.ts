import { MongoClient, type Collection, type Db } from 'mongodb';
import { config } from './config.js';

export interface ConversationDoc {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastMessageAt: Date;
  lastMessageText: string;
  updatedAt: Date;
}

export type OutboundStatus = 'queued' | 'sending' | 'sent' | 'delivered' | 'failed';

export interface MessageDoc {
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: Date;
  pigeonEventId?: string;
  pigeonMessageId?: string;
  clientRef?: string;
  status?: OutboundStatus;
  attempts?: number;
  nextAttemptAt?: Date;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventDoc {
  workspace: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type BillingStatus = 'none' | 'incomplete' | 'active' | 'past_due' | 'canceled';

export interface BillingDoc {
  workspace: string;
  customerId?: string;
  subscriptionId?: string;
  status: BillingStatus;
  seats: number;
  cancelAtPeriodEnd?: boolean;
  nextActionUrl?: string | null;
  lastError?: string | null;
  updatedAt: Date;
}

export interface NoteDoc {
  workspace: string;
  contact: string;
  authorSub: string;
  authorName: string;
  ciphertext: string;
  iv: string;
  createdAt: Date;
}

let client: MongoClient | undefined;
let indexesReady = false;

export async function getDb(): Promise<Db> {
  if (!client) {
    client = new MongoClient(config.mongoUrl);
    await client.connect();
  }
  const db = client.db();
  if (!indexesReady) {
    indexesReady = true;
    await Promise.all([
      db.collection('conversations').createIndex({ workspace: 1, contact: 1 }, { unique: true }),
      db.collection('conversations').createIndex({ workspace: 1, lastMessageAt: -1 }),
      db.collection('messages').createIndex(
        { workspace: 1, pigeonMessageId: 1 },
        { unique: true, partialFilterExpression: { direction: 'inbound', pigeonMessageId: { $type: 'string' } } }
      ),
      db.collection('messages').createIndex(
        { workspace: 1, clientRef: 1 },
        { unique: true, partialFilterExpression: { direction: 'outbound', clientRef: { $type: 'string' } } }
      ),
      db.collection('messages').createIndex({ workspace: 1, contact: 1, occurredAt: 1, _id: 1 }),
      db.collection('messages').createIndex({ direction: 1, status: 1, nextAttemptAt: 1, leaseUntil: 1 }),
      db.collection('events').createIndex({ workspace: 1, seq: 1 }, { unique: true }),
      db.collection('notes').createIndex({ workspace: 1, contact: 1, createdAt: 1 }),
      db.collection('billing').createIndex({ workspace: 1 }, { unique: true }),
    ]);
  }
  return db;
}

export async function collections() {
  const db = await getDb();
  return {
    db,
    conversations: db.collection<ConversationDoc>('conversations'),
    messages: db.collection<MessageDoc>('messages'),
    events: db.collection<EventDoc>('events'),
    notes: db.collection<NoteDoc>('notes'),
    billing: db.collection<BillingDoc>('billing'),
  };
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = undefined;
    indexesReady = false;
  }
}

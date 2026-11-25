import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BillingModal } from './BillingModal';
import {
  decryptNote,
  encryptNote,
  exportWorkspaceKeyString,
  importWorkspaceKeyString,
} from './crypto';
import './styles.css';

interface WorkspaceClaim {
  id: string;
  role: 'admin' | 'agent';
}

interface UserMe {
  sub: string;
  name?: string;
  email?: string;
  workspaces: WorkspaceClaim[];
}

interface Conversation {
  workspace: string;
  contact: string;
  assignee: string | null;
  status: 'open' | 'closed';
  lastMessageAt: string;
  lastMessageText: string;
}

interface Message {
  _id?: string;
  workspace: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  text: string;
  occurredAt: string;
  pigeonMessageId?: string;
  clientRef?: string;
  status?: 'queued' | 'sending' | 'sent' | 'delivered' | 'failed';
}

interface NoteItem {
  _id?: string;
  authorSub: string;
  authorName: string;
  ciphertext: string;
  iv: string;
  createdAt: string;
  plaintext?: string;
}

export function App() {
  const [user, setUser] = useState<UserMe | null | undefined>(undefined);
  const [workspace, setWorkspace] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedContact, setSelectedContact] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [replyText, setReplyText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [wsState, setWsState] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [showKeyBox, setShowKeyBox] = useState(false);
  const [showBilling, setShowBilling] = useState(false);

  const lastSeqRef = useRef<number | null>(null);
  const selectedContactRef = useRef<string | null>(null);
  selectedContactRef.current = selectedContact;

  useEffect(() => {
    fetch('/api/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UserMe | null) => {
        setUser(data);
        if (data && data.workspaces.length > 0) {
          setWorkspace(data.workspaces[0].id);
        }
      })
      .catch(() => setUser(null));
  }, []);

  const loadConversations = useCallback(async () => {
    if (!workspace) return;
    const res = await fetch(`/api/conversations?workspace=${encodeURIComponent(workspace)}&status=${statusFilter}`);
    if (res.ok) {
      const data = await res.json();
      setConversations(data.conversations || []);
    }
  }, [workspace, statusFilter]);

  const loadThread = useCallback(async (contact: string) => {
    if (!workspace) return;
    const [msgRes, noteRes] = await Promise.all([
      fetch(`/api/conversations/${encodeURIComponent(contact)}/messages?workspace=${encodeURIComponent(workspace)}`),
      fetch(`/api/conversations/${encodeURIComponent(contact)}/notes?workspace=${encodeURIComponent(workspace)}`),
    ]);
    if (msgRes.ok) {
      const d = await msgRes.json();
      setMessages(d.messages || []);
    }
    if (noteRes.ok) {
      const d = await noteRes.json();
      const rawNotes: NoteItem[] = d.notes || [];
      const decrypted = await Promise.all(
        rawNotes.map(async (n) => ({
          ...n,
          plaintext: await decryptNote(workspace, n.ciphertext, n.iv),
        }))
      );
      setNotes(decrypted);
    }
  }, [workspace]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (selectedContact) {
      void loadThread(selectedContact);
    } else {
      setMessages([]);
      setNotes([]);
    }
  }, [selectedContact, loadThread]);

  // Real-time WebSocket with seq replay on reconnect
  useEffect(() => {
    if (!workspace || !user) return;
    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;
    lastSeqRef.current = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const afterPart = lastSeqRef.current !== null ? `&after=${lastSeqRef.current}` : '';
      const url = `${proto}//${window.location.host}/ws?workspace=${encodeURIComponent(workspace)}${afterPart}`;
      ws = new WebSocket(url);

      ws.onopen = () => setWsState('connected');
      ws.onmessage = (ev) => {
        try {
          const frame = JSON.parse(ev.data);
          if (typeof frame.seq === 'number') {
            lastSeqRef.current = Math.max(lastSeqRef.current ?? -1, frame.seq);
          }
          void loadConversations();
          if (frame.contact && frame.contact === selectedContactRef.current) {
            if (frame.type === 'message.status' && frame.client_ref) {
              setMessages((prev) =>
                prev.map((m) => (m.clientRef === frame.client_ref ? { ...m, status: frame.status } : m))
              );
            } else {
              void loadThread(frame.contact);
            }
          }
        } catch {
          // ignore non-JSON
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setWsState('reconnecting');
        retryTimer = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, [workspace, user, loadConversations, loadThread]);

  const activeConv = useMemo(
    () => conversations.find((c) => c.contact === selectedContact) || null,
    [conversations, selectedContact]
  );

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.contact.toLowerCase().includes(q) || (c.lastMessageText || '').toLowerCase().includes(q)
    );
  }, [conversations, search]);

  async function handleClaim() {
    if (!selectedContact || !workspace) return;
    setErrorBanner(null);
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    if (res.status === 409) {
      const d = await res.json();
      setErrorBanner(`Already claimed by ${d.assignee}`);
    }
    await loadConversations();
  }

  async function handleRelease() {
    if (!selectedContact || !workspace) return;
    setErrorBanner(null);
    await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace }),
    });
    await loadConversations();
  }

  async function handleToggleStatus() {
    if (!activeConv || !workspace) return;
    const next = activeConv.status === 'open' ? 'closed' : 'open';
    await fetch(`/api/conversations/${encodeURIComponent(activeConv.contact)}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, status: next }),
    });
    await loadConversations();
  }

  async function handleSendReply() {
    if (!selectedContact || !workspace || !replyText.trim()) return;
    const text = replyText.trim();
    const clientRef = `ui_${crypto.randomUUID()}`;
    setReplyText('');
    setMessages((prev) => [
      ...prev,
      {
        workspace,
        contact: selectedContact,
        direction: 'outbound',
        text,
        occurredAt: new Date().toISOString(),
        clientRef,
        status: 'queued',
      },
    ]);
    const res = await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, text, client_ref: clientRef }),
    });
    if (res.status === 402) {
      setErrorBanner('Sending paused: workspace subscription is inactive/canceled.');
      setMessages((prev) => prev.filter((m) => m.clientRef !== clientRef));
    }
    await loadConversations();
  }

  async function handleAddNote() {
    if (!selectedContact || !workspace || !noteText.trim()) return;
    const text = noteText.trim();
    setNoteText('');
    const { ciphertext, iv } = await encryptNote(workspace, text);
    await fetch(`/api/conversations/${encodeURIComponent(selectedContact)}/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace, ciphertext, iv }),
    });
    await loadThread(selectedContact);
  }

  if (user === undefined) {
    return <div className="login-shell">Loading Switchboard…</div>;
  }

  if (user === null) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Switchboard</h1>
          <p>Shared team inbox for multi-workspace support teams. Sign in through the identity provider to continue.</p>
          <a className="btn btn-primary" href="/auth/login" style={{ display: 'inline-block', textDecoration: 'none' }}>
            Sign in with Switchboard IdP
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">Switchboard</span>
          <select
            value={workspace}
            onChange={(e) => {
              setWorkspace(e.target.value);
              setSelectedContact(null);
            }}
            style={{ width: 'auto' }}
          >
            {user.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.id} ({w.role})
              </option>
            ))}
          </select>
          <span className={`badge ${wsState === 'connected' ? 'ok' : 'warn'}`}>
            {wsState === 'connected' ? 'Live' : 'Reconnecting'}
          </span>
        </div>
        <div className="topbar-right">
          {user.workspaces.find((w) => w.id === workspace)?.role === 'admin' && (
            <button className="btn" onClick={() => setShowBilling(true)}>
              Billing
            </button>
          )}
          <span style={{ fontSize: 13, color: 'var(--muted)' }}>{user.name || user.sub}</span>
          <button
            className="btn"
            onClick={async () => {
              await fetch('/auth/logout', { method: 'POST' });
              setUser(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="workspace-grid">
        {/* Left: Inbox */}
        <aside className="pane">
          <div className="tabs">
            {(['open', 'closed', 'all'] as const).map((t) => (
              <button
                key={t}
                className={`tab ${statusFilter === t ? 'active' : ''}`}
                onClick={() => setStatusFilter(t)}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="search-box">
            <input
              placeholder="Filter contact or message…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="conv-list">
            {filteredConversations.map((c) => (
              <div
                key={c.contact}
                className={`conv-item ${selectedContact === c.contact ? 'active' : ''}`}
                onClick={() => {
                  setErrorBanner(null);
                  setSelectedContact(c.contact);
                }}
              >
                <div className="conv-top">
                  <span className="conv-contact">{c.contact}</span>
                  <span className={`badge ${c.assignee === user.sub ? 'ok' : c.assignee ? 'warn' : ''}`}>
                    {c.assignee === user.sub ? 'Yours' : c.assignee || 'Unassigned'}
                  </span>
                </div>
                <div className="conv-preview">{c.lastMessageText || 'No messages yet'}</div>
              </div>
            ))}
            {filteredConversations.length === 0 && (
              <div className="empty-state" style={{ padding: 24 }}>No conversations</div>
            )}
          </div>
        </aside>

        {/* Center: Thread */}
        <main className="thread-pane">
          {selectedContact ? (
            <>
              <div className="thread-header">
                <div>
                  <strong>{selectedContact}</strong>
                  {activeConv && (
                    <span className="badge" style={{ marginLeft: 8 }}>
                      {activeConv.status}
                    </span>
                  )}
                  {errorBanner && (
                    <span className="badge err" style={{ marginLeft: 8 }}>
                      {errorBanner}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {activeConv?.assignee === user.sub ? (
                    <button className="btn" onClick={handleRelease}>Release</button>
                  ) : (
                    <button className="btn btn-primary" onClick={handleClaim}>Claim</button>
                  )}
                  {activeConv && (
                    <button className="btn" onClick={handleToggleStatus}>
                      {activeConv.status === 'open' ? 'Close' : 'Reopen'}
                    </button>
                  )}
                </div>
              </div>

              <div className="messages-scroll">
                {messages.map((m, idx) => (
                  <div key={m._id || m.clientRef || idx} className={`msg-row ${m.direction}`}>
                    <div className="bubble">{m.text}</div>
                    <div className="msg-meta">
                      <span>{new Date(m.occurredAt).toLocaleTimeString()}</span>
                      {m.direction === 'outbound' && m.status && <span>· {m.status}</span>}
                    </div>
                  </div>
                ))}
              </div>

              <div className="composer">
                <textarea
                  rows={2}
                  placeholder="Write a reply… (Enter to send)"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void handleSendReply();
                    }
                  }}
                />
                <button className="btn btn-primary" onClick={handleSendReply}>Send</button>
              </div>
            </>
          ) : (
            <div className="empty-state">Select a conversation to view messages</div>
          )}
        </main>

        {/* Right: E2EE Private Notes */}
        <aside className="pane">
          <div className="pane-header">
            <strong style={{ fontSize: 13 }}>Private Notes (E2EE)</strong>
            <button className="btn" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => {
              setKeyInput(exportWorkspaceKeyString(workspace));
              setShowKeyBox((v) => !v);
            }}>
              Key
            </button>
          </div>
          {showKeyBox && (
            <div style={{ padding: 10, borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ color: 'var(--muted)', marginBottom: 4 }}>Workspace AES-GCM Key (base64):</div>
              <input
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                style={{ width: '100%', padding: 4, fontSize: 11, marginBottom: 6 }}
              />
              <button
                className="btn"
                style={{ fontSize: 11 }}
                onClick={() => {
                  importWorkspaceKeyString(workspace, keyInput);
                  setShowKeyBox(false);
                  if (selectedContact) void loadThread(selectedContact);
                }}
              >
                Import Key
              </button>
            </div>
          )}
          <div className="notes-list">
            {notes.map((n, i) => (
              <div key={n._id || i} className="note-card">
                <div className="note-author">{n.authorName} · {new Date(n.createdAt).toLocaleTimeString()}</div>
                <div>{n.plaintext}</div>
              </div>
            ))}
            {selectedContact && notes.length === 0 && (
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>No private notes yet. Encrypted in your browser.</div>
            )}
          </div>
          {selectedContact && (
            <div className="composer" style={{ padding: 10 }}>
              <textarea
                rows={2}
                placeholder="Private agent note…"
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
              />
              <button className="btn" onClick={handleAddNote}>Save</button>
            </div>
          )}
        </aside>
      </div>
      {showBilling && workspace && (
        <BillingModal workspace={workspace} onClose={() => setShowBilling(false)} />
      )}
    </div>
  );
}

# Architectural & Scoping Decisions

## What We Built
- **Full Core Product**: OIDC login with PKCE (`S256`) and Redis-backed sessions (`sb_sid`), multi-tenant workspace isolation, Pigeon webhook ingestion (`POST /webhooks/pigeon`) with HMAC-SHA256 + 5-minute replay protection, atomic conversation claiming, durable outbound reply queue with `Idempotency-Key`, real-time WebSocket updates (`/ws?workspace=...&after=...`) with Redis Pub/Sub fan-out and MongoDB `seq` replay, and a 3-column React inbox UI.
- **Failure Resilience**:
  - **No in-memory state**: Conversations, messages, outbound queue, and WebSocket `seq` events are persisted in MongoDB; sessions, `seq` counters, and rate-limit state live in Redis.
  - **Multi-instance coordination**: Outbound worker uses atomic MongoDB `findOneAndUpdate` leases (`20s` TTL) so if one instance is killed (`kill -9`), another instance picks up its work well within 60s. Per-workspace Pigeon rate limiting (`7` burst, `3.5/s` refill) and `Retry-After` cool-offs are coordinated globally via Redis Lua scripts.
  - **Monotonic status & deduplication**: Unique partial indexes on `(workspace, pigeonMessageId)` and `(workspace, clientRef)` prevent duplicate inbound/outbound records; outbound status transitions are strictly monotonic (`queued -> sending -> sent -> delivered|failed`) so out-of-order webhooks never regress state.
- **E2EE Private Notes**: Browser-side Web Crypto `AES-GCM` encryption (`PROTOCOL.md`).

## What We Cut & Why
- **Elasticsearch full-text search**: Cut to prioritize reliability under crashes, outages, and multi-instance load balancing (75/85 automated check points). Filtering by contact/last message is handled in the React UI.
- **Paybox per-seat billing (`BONUS_BILLING.md`)**: Cut intentionally to stay within the 2-hour window and focus on correctness and tests.

## Assumptions Where Brief Is Silent
- **Unknown Pigeon workspaces/event types**: Acknowledged with `200` and ignored per `PIGEON.md`, rather than `4xx`/`5xx` which would trigger unnecessary retries.
- **Conversation creation on outbound**: Claiming or replying to a contact who has not written yet upserts the conversation as `open` with `assignee: null`.
- **Workspace E2EE key distribution**: Assumed agents share the workspace AES-GCM key out-of-band via the UI's export/import key control.

## What Is Still Known to Be Imperfect
- **Windows `check.js` `SIGKILL` behavior**: On Windows, `harness/check.js` uses `process.kill(-pid, 'SIGKILL')`, which does not terminate grandchild `node` processes on Win32; on Linux/macOS (and in our Windows-patched verification run) process-group kill works as designed.
- **Polling interval on outbound worker**: The outbound worker polls MongoDB every `250ms` when idle; under very high throughput, Redis-backed wakeups across instances would reduce DB polling load.

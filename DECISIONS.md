# Architectural & Scoping Decisions

## What We Built
- **Full Core Product**: OIDC login with PKCE (`S256`) and JWKS ID-token verification (`jose`), Redis-backed sessions (`sb_sid`), multi-tenant workspace isolation, Pigeon webhook ingestion (`POST /webhooks/pigeon`) with HMAC-SHA256 + 5-min replay protection, atomic conversation claiming, durable outbound reply pool with `Idempotency-Key`, real-time WebSocket updates (`/ws?workspace=...&after=...`) with Redis Pub/Sub fan-out and MongoDB `seq` replay, React inbox UI, E2EE private notes (`PROTOCOL.md`), and Paybox per-seat billing (`BONUS_BILLING.md`).
- **Failure & Concurrency Design**:
  - **Durable `seq` + write-before-publish**: `counters` + `events` are written to MongoDB **before** publishing to Redis Pub/Sub, serialized per workspace so live frames remain strictly ordered and reconnect replay (`after=<seq>`) never loses an event even if Redis restarts.
  - **Idempotent webhooks**: Conversation upserts use conditional aggregation updates so out-of-order inbound messages never overwrite newer `lastMessageText`; events use a unique `(workspace, dedupeKey)` index so crash retries mid-webhook finish safely.
  - **Multi-instance outbound pool**: Continuous 6-slot worker pool with MongoDB `18s` leases, terminal handling for non-429 `4xx`/max retries, and Redis Lua token-bucket (`7` burst, `3.5/s`) + shared `Retry-After` cool-offs.

## What We Cut & Why
- **Elasticsearch full-text search**: Cut to prioritize reliability under crashes, outages, multi-instance failover (75/75 check), E2EE notes, and Paybox billing. Contact/preview filtering is handled client-side.

## Assumptions & Billing Decisions
- **`past_due` policy**: Allowed to send during Paybox's 3-day / 5-day retry window; blocked (`402`) once `canceled`, while inbox reads stay open.
- **Seats reduced below active agents**: Decreases take effect immediately on Paybox without revoking IdP access; admin sees a credit notice for unused time.
- **3DS (`requires_action`)**: Stored as `incomplete` (`can_send: false`) with a bank approval link; Paybox webhooks sync `GET /v1/subscriptions/:id` on completion.

## What Is Still Known to Be Imperfect
- **Session role freshness**: User workspace roles are cached in the Redis session (`12h` TTL) at OIDC login; removing a user at the IdP does not revoke an active session mid-window without re-login or token introspection.
- **Per-contact outbound ordering**: The 6-slot worker pool sends across messages concurrently, so two replies sent in the same millisecond to the *same* contact could reach Pigeon out of order if the first encounters a transient `503` or 12s delay.
- **Out-of-band E2EE key distribution**: Workspace AES-GCM keys are exported/imported manually rather than wrapped per user via asymmetric key pairs.
- **Windows `check.js` `SIGKILL`**: On Windows, `harness/check.js` uses `process.kill(-pid, 'SIGKILL')`, which does not terminate grandchild `node` processes on Win32; Linux/macOS process-group kill works as designed.

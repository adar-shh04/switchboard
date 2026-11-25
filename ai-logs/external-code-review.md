# External AI Code Review (Pre-Fix)

Harness is untouched and the check report shows full marks on levels 1, 2, 3, 5. Now reading the server code to look for level-4 rule gaps, security, and quality issues.

Your usage limit was reached partway through, so this review covers the server code and the frontend's crypto, WebSocket and reply code. I didn't read `billing.ts`, `BillingModal.tsx`, most of the rest of `App.tsx` (the JSX layout), or the ai-logs.

**Overall:** strong submission. The harness files match the starter (I compared them), and `CHECK_REPORT.json` gives full marks on levels 1, 2, 3 and 5. Signature checking, the claim logic, the outbound lease queue and the shared Redis rate limit are all sound. What follows is what an interviewer is likely to push on.

## Fix first (correctness)

1. **A crash or error mid-webhook can leave a message without its conversation or WebSocket event, permanently.** In `pigeon.ts:73-113`, the conversation update and event only run when `upsertedCount > 0`. If the process dies, or a later step errors, after the message insert, Pigeon's retry finds the message already stored and skips both. The conversation is never created or bumped, and connected clients never see the message. **Fix:** always run the conversation `$max` upsert, which is safe to repeat, and make the event safe to repeat too: add a unique key like `(workspace, dedupeKey = message_id)` on `events`.

2. **The event is published before it is saved** (`events.ts`). The Lua script does INCR and PUBLISH, then `insertOne` runs afterwards. A crash in between means live clients saw that `seq` but replay never will. A reconnect that lands in that gap also misses it, which breaks "a reconnecting client misses nothing". **Fix:** save to Mongo first, then publish.

3. **`seq` lives only in Redis.** If Redis loses its data, INCR starts again at 1. `insertOne` then hits the unique `(workspace, seq)` index, the webhook handler returns 500, and the retry is silently skipped because of item 1. **Fix:** on startup, seed the counter from the highest `seq` in Mongo, or keep the counter in Mongo with `$inc`.

4. **The `workspace in config.pigeon.apiKeys` check also matches built-in names** like `"constructor"` and `"toString"` (`pigeon.ts:52`, `routes.ts:122`). So the brief's rule that an unknown workspace gets a 4xx breaks, and a signed webhook would store data under `toString`. **Fix:** use `Object.hasOwn()` or a `Map`.

5. **Replies that can never succeed are retried forever.** Any non-429 4xx from Pigeon is retried with backoff and never marked `failed`, and there is no attempt limit (`pigeon.ts:378-396`). **Fix:** treat 4xx except 429 as `failed`, cap attempts, and emit a status frame.

## Authorization and security

- **Anyone in the workspace can release someone else's claim** (`routes.ts:238`), so "two agents cannot both hold it" can be bypassed by releasing and then claiming. Only the holder or an admin should be allowed to release. Close and reopen have the same gap.
- **Request bodies aren't type-checked.** `contact` and `agent` on the grader routes go straight into Mongo filters, so an object like `{"$ne":null}` becomes a query operator (operator injection). It's behind the grader token, but a schema library such as zod is cheap insurance.
- **The ID token's signature isn't checked** (`auth.ts:175`). Neither are `iss`, `aud` or `exp`, and the nonce is only compared when the claim is present. The main path, userinfo, never checks the nonce. Verify the token against the IdP's published keys (the `jose` library does this).
- **Roles are copied into the session for 12 hours**, so removing someone at the IdP doesn't take effect until then. Also, the WebSocket upgrade doesn't check `Origin`, and error responses include internal detail (`detail: String(err)`, the raw token-exchange body).

## Encrypted notes (`PROTOCOL.md`)

- **In practice, agents can't read each other's notes.** Each browser makes its own random key on first use (`crypto.ts:28`), so until keys are copied by hand everyone sees "Encrypted with another key".
- **Nothing ties a note to its conversation or author.** The encryption has no associated data, so the server can move a note to another conversation or change the author, and it still decrypts cleanly. Fix this by passing `workspace|contact|authorSub|noteId` as AES-GCM associated data. This is also a sharper example for your "attacks it doesn't stop" list than metadata.
- **Better design to mention:** per-user key pairs, with the workspace key encrypted to each member. Say plainly that the server could still swap public keys unless users compare fingerprints.

## Robustness and quality

- **The outbound worker stalls on one slow request.** It claims up to 6 messages, then waits for all of them, so one 12-second slow Pigeon response holds up the whole batch. Use a continuous pool instead. Concurrent sends can also reorder replies to the same contact.
- **WebSocket gaps:** `after=0` replays the whole history with no limit, the `events` collection grows forever (add a TTL index), and there's no ping/pong heartbeat.
- **Bad paging values crash the request.** A non-numeric `limit` or `offset` passes `NaN` to the driver, which errors and returns a 500. The messages endpoint isn't paginated at all.
- **Out-of-order inbound messages overwrite the preview text.** `lastMessageText` is always overwritten while `lastMessageAt` uses `$max`, so an older message that arrives late becomes the conversation preview.
- **Frontend:** every WebSocket frame refetches the conversation list and often the thread. That will storm the server during bursts, so debounce it. If the reply request fails on the network, the message stays shown as "queued" forever; retry it with the same `client_ref`.
- **Tests only cover the signature check and status transitions.** Add a test for claim races and for duplicate or out-of-order inbound against a real Mongo; that's where items 1–3 would have shown up.

## `DECISIONS.md`

It's good, but its "still wrong" section lists two minor items. Adding items 1–3 above would show you understand your own failure modes, which the brief says is worth more than silence.

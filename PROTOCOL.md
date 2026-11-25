# Private Notes Encryption Protocol (`PROTOCOL.md`)

## Overview
Switchboard supports end-to-end encrypted (E2EE) private notes on conversations so agents in the same workspace can collaborate without the server being able to read note contents.

## Keys & Ownership
- **Workspace Symmetric Key (`K_ws`)**: A 256-bit `AES-GCM` key generated in the browser via the Web Crypto API (`crypto.subtle.generateKey`).
- **Who holds it**: Only the agents' browsers (`localStorage` under `sb_note_key_<workspace>`). Teammates import/export the key out-of-band in the UI. (Production upgrade: each agent generates a browser keypair and wraps `K_ws` to each member's public key.)
- **Server knowledge**: The server **never** receives `K_ws` or plaintext notes.

## What the Server Stores
For each note in MongoDB (`notes` collection), the server stores:
- `workspace`, `contact`, `authorSub`, `authorName`, `createdAt`
- `iv`: base64-encoded 96-bit random IV generated per note
- `ciphertext`: base64-encoded AES-GCM ciphertext + 128-bit auth tag, authenticated with Associated Data (`AAD = "${workspace}|${contact}|${authorSub}"`)

Binding `workspace|contact|authorSub` as AES-GCM AAD prevents the server from silently relocating a ciphertext to another conversation or attributing it to a different author without breaking GCM tag verification.

## Three Attacks This Scheme Does NOT Stop
1. **Malicious server / XSS**: The server delivers the React bundle; a compromised server or XSS bug can inject code to read `K_ws` or plaintext directly in the browser. (Even with per-user asymmetric key wrapping, a malicious server can swap public keys unless agents verify key fingerprints out-of-band.)
2. **Revoked agent access**: Because `K_ws` is shared and cached in `localStorage`, removing an agent in the IdP does not prevent them from decrypting previously fetched ciphertexts without key rotation.
3. **Traffic & metadata analysis**: The server still observes `authorSub`, `createdAt`, target `contact`, and ciphertext size.

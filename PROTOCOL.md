# Private Notes Encryption Protocol (`PROTOCOL.md`)

## Overview
Switchboard supports end-to-end encrypted (E2EE) private notes on conversations so agents in the same workspace can collaborate without the server being able to read note contents.

## Keys & Ownership
- **Workspace Symmetric Key (`K_ws`)**: A 256-bit `AES-GCM` key generated in the browser via the Web Crypto API (`crypto.subtle.generateKey`).
- **Who holds it**: Only the agents' browsers (`localStorage` under `sb_note_key_<workspace>`). Agents can export/import the base64 key in the UI to share it out-of-band with teammates in the same workspace.
- **Server knowledge**: The server **never** receives `K_ws` or plaintext notes.

## What the Server Stores
For each note in MongoDB (`notes` collection), the server stores only:
- `workspace`, `contact`, `authorSub`, `authorName`, `createdAt`
- `iv`: base64-encoded 96-bit random IV generated per note in the browser
- `ciphertext`: base64-encoded AES-GCM ciphertext (which includes the 128-bit authentication tag)

## Three Attacks This Scheme Does NOT Stop
1. **Malicious or compromised server / XSS**: Because the server serves the React bundle (and could inject malicious JS or exfiltrate `localStorage`), a compromised server or XSS vulnerability can steal `K_ws` from the browser.
2. **Metadata analysis**: The server still observes *who* (`authorSub`), *when* (`createdAt`), *which conversation* (`workspace`, `contact`), and *approximate note length* (`ciphertext.length`).
3. **Revoked agent access**: Because `K_ws` is a shared workspace key stored in `localStorage`, removing an agent from the workspace in the IdP does not prevent them from decrypting previously downloaded ciphertexts (or future ones if they retain `K_ws` and obtain API access), since there is no per-user asymmetric key wrapping or key rotation.

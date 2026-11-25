// Client-side AES-GCM encryption for private agent notes with Associated Data (AAD).
// The server only ever sees base64(iv) and base64(ciphertext) and cannot swap notes
// across conversations or authors without failing GCM authentication.

const STORAGE_PREFIX = 'sb_note_key_';

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function buildAad(workspace: string, contact: string, authorSub: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(`${workspace}|${contact}|${authorSub}`);
  const buf = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(buf).set(encoded);
  return new Uint8Array(buf);
}

export async function getOrCreateWorkspaceKey(workspace: string): Promise<CryptoKey> {
  const stored = localStorage.getItem(STORAGE_PREFIX + workspace);
  if (stored) {
    return crypto.subtle.importKey('raw', fromBase64(stored), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', key);
  localStorage.setItem(STORAGE_PREFIX + workspace, toBase64(raw));
  return key;
}

export function exportWorkspaceKeyString(workspace: string): string {
  return localStorage.getItem(STORAGE_PREFIX + workspace) || '';
}

export function importWorkspaceKeyString(workspace: string, b64: string): void {
  localStorage.setItem(STORAGE_PREFIX + workspace, b64.trim());
}

export async function encryptNote(
  workspace: string,
  contact: string,
  authorSub: string,
  plaintext: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await getOrCreateWorkspaceKey(workspace);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: buildAad(workspace, contact, authorSub) },
    key,
    encoded
  );
  return { ciphertext: toBase64(cipher), iv: toBase64(iv) };
}

export async function decryptNote(
  workspace: string,
  contact: string,
  authorSub: string,
  ciphertext: string,
  iv: string
): Promise<string> {
  try {
    const key = await getOrCreateWorkspaceKey(workspace);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv), additionalData: buildAad(workspace, contact, authorSub) },
      key,
      fromBase64(ciphertext)
    );
    return new TextDecoder().decode(plain);
  } catch {
    return '[Unable to decrypt — missing key or tampered context]';
  }
}

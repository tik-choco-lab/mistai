// Node/request id helpers, shared by every module that needs a UUID and by
// apps that want a stable per-browser node identity.

// crypto.randomUUID is only available in secure contexts (HTTPS/localhost);
// fall back to getRandomValues when served over plain HTTP on the LAN.
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const DEFAULT_NODE_ID_STORAGE_KEY = "mistai:node-id";

// In-memory fallback so repeated calls within one page/session stay stable
// even when localStorage is unavailable (private mode, Node, sandboxed iframe).
const memoryIds = new Map<string, string>();

/**
 * Returns a persistent node id for this browser profile, generating and
 * storing one under `storageKey` on first use. Never throws: if localStorage
 * is unavailable it falls back to an in-memory id (stable for the session).
 */
export function getPersistentNodeId(storageKey: string = DEFAULT_NODE_ID_STORAGE_KEY): string {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) {
      const existing = storage.getItem(storageKey);
      if (existing) return existing;
      const id = randomId();
      storage.setItem(storageKey, id);
      return id;
    }
  } catch {
    // Fall through to the in-memory fallback below.
  }
  const existing = memoryIds.get(storageKey);
  if (existing) return existing;
  const id = randomId();
  memoryIds.set(storageKey, id);
  return id;
}

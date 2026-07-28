// localStorage access for the shared DelegationV1 record. Co-owned across
// every tik-choco app on the origin (see did-delegation.md's "共有キー"
// section) — same "last-write-wins, value stored directly (no CID
// indirection)" pattern as llm-config.ts's tc-shared-llm-config-v1, and the
// same defensive-storage-access idiom as ./id.ts's getPersistentNodeId
// (indirect `globalThis.localStorage` lookup, try/catch, never throw).
import { parseDelegation, verifyDelegation, type DelegationV1 } from "./delegation.js";

export const SHARED_DELEGATION_KEY = "tc-shared-did-delegation-v1";

export function loadDelegation(): DelegationV1 | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (storage) return parseDelegation(storage.getItem(SHARED_DELEGATION_KEY));
  } catch {
    // Storage disabled/unavailable (private mode, sandboxed iframe, ...) — treat as "nothing saved".
  }
  return undefined;
}

export function saveDelegation(delegation: DelegationV1): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    storage?.setItem(SHARED_DELEGATION_KEY, JSON.stringify(delegation));
  } catch {
    // Never throw: a full/blocked store just means the delegation isn't persisted this time.
  }
}

export function clearDelegation(): void {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    storage?.removeItem(SHARED_DELEGATION_KEY);
  } catch {
    // Ignore — nothing useful a caller can do about a storage failure here.
  }
}

/**
 * Loads the stored delegation and returns it only if it verifies for `leaf`.
 * Per did-delegation.md's "共有キー" section: a broken/expired/foreign-leaf
 * value is silently ignored (returns undefined) WITHOUT clearing the key —
 * it may belong to a different device/leaf that shares this origin's
 * storage, and clobbering it would be destructive for that other leaf.
 */
export async function loadDelegationFor(leaf: string): Promise<DelegationV1 | undefined> {
  const stored = loadDelegation();
  if (!stored) return undefined;
  return (await verifyDelegation(stored, { leaf })) ? stored : undefined;
}

/**
 * Subscribes to cross-tab/cross-app updates of `tc-shared-did-delegation-v1`
 * via the `storage` window event, mirroring llm-config.ts's
 * subscribeLlmConfig. Delivers the raw parsed value (not leaf-verified —
 * callers who need a verified delegation for a specific leaf should re-run
 * loadDelegationFor themselves) so this stays usable for "did something
 * change" notifications regardless of which leaf the caller cares about.
 * Returns an unsubscribe function.
 */
export function subscribeDelegation(cb: (delegation: DelegationV1 | undefined) => void): () => void {
  function onStorageEvent(event: StorageEvent) {
    if (event.key !== SHARED_DELEGATION_KEY) return;
    cb(loadDelegation());
  }

  window.addEventListener("storage", onStorageEvent);
  return () => window.removeEventListener("storage", onStorageEvent);
}

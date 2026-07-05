import { afterEach, describe, expect, it, vi } from "vitest";
import { getPersistentNodeId, randomId, DEFAULT_NODE_ID_STORAGE_KEY } from "../id.js";

function makeFakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
    _store: store,
  } as unknown as Storage & { _store: Map<string, string> };
}

describe("randomId", () => {
  it("returns unique UUID-shaped strings", () => {
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });
});

describe("getPersistentNodeId", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores a generated id under the default key and reuses it", () => {
    const storage = makeFakeStorage();
    vi.stubGlobal("localStorage", storage);

    const first = getPersistentNodeId();
    expect(storage._store.get(DEFAULT_NODE_ID_STORAGE_KEY)).toBe(first);
    expect(getPersistentNodeId()).toBe(first);
  });

  it("returns an already stored id verbatim", () => {
    const storage = makeFakeStorage();
    storage._store.set("custom-key", "existing-id");
    vi.stubGlobal("localStorage", storage);

    expect(getPersistentNodeId("custom-key")).toBe("existing-id");
  });

  it("falls back to a stable in-memory id when localStorage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });

    const key = `throwing-${randomId()}`;
    const first = getPersistentNodeId(key);
    expect(first).toBeTruthy();
    expect(getPersistentNodeId(key)).toBe(first);
  });

  it("does not throw when localStorage is entirely absent", () => {
    // Plain Node (the vitest default environment) has no localStorage unless
    // explicitly enabled, so this exercises the in-memory path directly.
    const key = `absent-${randomId()}`;
    const first = getPersistentNodeId(key);
    expect(getPersistentNodeId(key)).toBe(first);
  });
});

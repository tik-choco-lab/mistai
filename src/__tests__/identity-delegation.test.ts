import { describe, expect, it } from "vitest";
import { createDidIdentity, verifyStringWithDid, type DidIdentity } from "../identity/didKey.js";
import { delegationSigningPayload, signDelegation, verifyDelegation, parseDelegation, type DelegationV1 } from "../identity/delegation.js";

async function makeRootAndLeaf(): Promise<{ root: DidIdentity; leaf: DidIdentity }> {
  const [root, leaf] = await Promise.all([createDidIdentity(), createDidIdentity()]);
  return { root, leaf };
}

// Pinned cross-implementation vector, shared byte-for-byte with mistl's Rust
// port (`src/identity/delegation.rs`, `verify_accepts_a_delegation_signed_by_
// _the_typescript_implementation`). It was produced by this file's own
// signDelegation() with the fixed Ed25519 seed `ca22031e...` that wiresign.rs's
// interop vectors already use. Pinning it on both sides means neither
// implementation can drift on the signing payload, the RFC 3339 millisecond
// time format, or the unpadded-base64url signature encoding without a test
// going red. Regenerate only if the spec's signing rules change.
const CROSS_IMPL_DELEGATION: DelegationV1 = {
  v: 1,
  root: "did:key:z6MkrNaiFHW7PvxfTPbQJKg74twJH4v7BgcPJxQxoN6cCaQ4",
  leaf: "did:key:z6MkoTHsgNNrby9J7Yaso8QUn2Aza4A5A8zk4B7EudJRDoLU",
  iat: "2026-01-01T00:00:00.000Z",
  exp: "2026-03-01T00:00:00.000Z",
  sig: "hHTdbP1RnTGJuo9n6ksuWnnO_maEGUGvsL3d2pnKW9gxRZ6AWcTL09CxHQvdR8bgPO2schhNsvfKWUSdAcgFAA",
};

describe("cross-implementation vector (shared with mistl's Rust port)", () => {
  it("verifies inside its validity window", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(await verifyDelegation(CROSS_IMPL_DELEGATION, { now })).toBe(true);
    expect(await verifyDelegation(CROSS_IMPL_DELEGATION, { now, leaf: CROSS_IMPL_DELEGATION.leaf })).toBe(true);
  });

  it("has the exact signing payload both implementations must produce", () => {
    expect(delegationSigningPayload(CROSS_IMPL_DELEGATION)).toBe(
      '{"exp":"2026-03-01T00:00:00.000Z","iat":"2026-01-01T00:00:00.000Z"' +
        ',"leaf":"did:key:z6MkoTHsgNNrby9J7Yaso8QUn2Aza4A5A8zk4B7EudJRDoLU"' +
        ',"root":"did:key:z6MkrNaiFHW7PvxfTPbQJKg74twJH4v7BgcPJxQxoN6cCaQ4","v":1}',
    );
  });

  it("stops verifying outside the window or once tampered with", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(await verifyDelegation(CROSS_IMPL_DELEGATION, { now: new Date("2026-06-01T00:00:00.000Z") })).toBe(false);
    expect(await verifyDelegation(CROSS_IMPL_DELEGATION, { now: new Date("2025-12-01T00:00:00.000Z") })).toBe(false);
    expect(await verifyDelegation({ ...CROSS_IMPL_DELEGATION, exp: "2027-03-01T00:00:00.000Z" }, { now })).toBe(false);
  });
});

describe("signDelegation / verifyDelegation", () => {
  it("round-trips a freshly signed delegation", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const delegation = await signDelegation(root, leaf.did);

    expect(delegation.v).toBe(1);
    expect(delegation.root).toBe(root.did);
    expect(delegation.leaf).toBe(leaf.did);
    expect(await verifyDelegation(delegation)).toBe(true);
    expect(await verifyDelegation(delegation, { leaf: leaf.did })).toBe(true);
  });

  it("produces the key-sorted signing payload the spec requires", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const now = new Date("2026-07-28T04:05:06.789Z");
    const delegation = await signDelegation(root, leaf.did, { now, ttlMs: 60 * 24 * 60 * 60 * 1000 });

    const payload = delegationSigningPayload(delegation);
    expect(payload).toBe(
      `{"exp":"${delegation.exp}","iat":"${delegation.iat}","leaf":"${leaf.did}","root":"${root.did}","v":1}`,
    );
    expect(delegation.iat).toBe("2026-07-28T04:05:06.789Z");
    expect(await verifyStringWithDid(root.did, payload, delegation.sig)).toBe(true);
  });

  it("rejects a leaf mismatch when pinned", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const delegation = await signDelegation(root, leaf.did);
    const other = await createDidIdentity();
    expect(await verifyDelegation(delegation, { leaf: other.did })).toBe(false);
  });

  it("rejects an expired delegation", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const delegation = await signDelegation(root, leaf.did, { now, ttlMs: 1000 });
    const later = new Date("2026-01-01T00:10:00.000Z"); // 10 min later, well past the 5 min skew allowance.
    expect(await verifyDelegation(delegation, { now: later })).toBe(false);
  });

  it("rejects iat >= exp (constructed directly, since signDelegation can't produce this)", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const now = new Date("2026-01-01T00:00:00.000Z").getTime();
    const unsigned = { v: 1 as const, root: root.did, leaf: leaf.did, iat: new Date(now).toISOString(), exp: new Date(now).toISOString() };
    const sig = await import("../identity/didKey.js").then((m) => m.signStringWithDidIdentity(root, delegationSigningPayload(unsigned)));
    const delegation: DelegationV1 = { ...unsigned, sig };
    expect(await verifyDelegation(delegation)).toBe(false);
  });

  it("rejects a lifetime over the 400-day sanity ceiling", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const delegation = await signDelegation(root, leaf.did, { now, ttlMs: 401 * 24 * 60 * 60 * 1000 });
    expect(await verifyDelegation(delegation, { now })).toBe(false);
  });

  it("rejects self-delegation (root === leaf)", async () => {
    const { root } = await makeRootAndLeaf();
    const delegation = await signDelegation(root, root.did);
    expect(await verifyDelegation(delegation)).toBe(false);
  });

  it("rejects a tampered signature", async () => {
    const { root, leaf } = await makeRootAndLeaf();
    const delegation = await signDelegation(root, leaf.did);
    const tampered = { ...delegation, leaf: (await createDidIdentity()).did };
    expect(await verifyDelegation(tampered)).toBe(false);
  });

  it("rejects malformed/foreign shapes without throwing", async () => {
    expect(await verifyDelegation(null)).toBe(false);
    expect(await verifyDelegation("not an object")).toBe(false);
    expect(await verifyDelegation({ v: 2 })).toBe(false);
    expect(await verifyDelegation({ v: 1, root: "did:key:znotreal", leaf: "did:key:znotreal2", iat: "x", exp: "y", sig: "z" })).toBe(
      false,
    );
  });
});

describe("parseDelegation", () => {
  it("parses a well-shaped delegation without checking the signature", () => {
    const raw: DelegationV1 = {
      v: 1,
      root: "did:key:zRoot",
      leaf: "did:key:zLeaf",
      iat: "2026-01-01T00:00:00.000Z",
      exp: "2026-03-01T00:00:00.000Z",
      sig: "not-a-real-signature",
    };
    expect(parseDelegation(JSON.stringify(raw))).toEqual(raw);
  });

  it("returns undefined for malformed input, never throws", () => {
    expect(parseDelegation(null)).toBeUndefined();
    expect(parseDelegation(undefined)).toBeUndefined();
    expect(parseDelegation("not json")).toBeUndefined();
    expect(parseDelegation(JSON.stringify({ v: 1, root: "x" }))).toBeUndefined();
  });
});

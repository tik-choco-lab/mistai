import { describe, expect, it } from "vitest";
import { createDidIdentity } from "../identity/didKey.js";
import { signDelegation } from "../identity/delegation.js";
import { signWireWithDelegation, verifyWire, resolveWireSender } from "../identity/wire.js";

describe("signWireWithDelegation / verifyWire / resolveWireSender", () => {
  it("throws when fromId doesn't match the signing identity", async () => {
    const leaf = await createDidIdentity();
    await expect(signWireWithDelegation({ fromId: "did:key:zSomeoneElse", body: "hi" }, leaf)).rejects.toThrow();
  });

  it("signs a plain wire (no delegation) that resolves to the leaf itself", async () => {
    const leaf = await createDidIdentity();
    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf);

    expect(await verifyWire(wire)).toBe(true);
    const resolved = await resolveWireSender(wire);
    expect(resolved).toEqual({ id: leaf.did, leaf: leaf.did, delegated: false });
  });

  it("signs a wire with a delegation that resolves to root", async () => {
    const root = await createDidIdentity();
    const leaf = await createDidIdentity();
    const delegation = await signDelegation(root, leaf.did);

    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf, delegation);

    // The delegation-unaware low-level check must still pass: this is the
    // backward-compat guarantee did-delegation.md relies on — a legacy
    // verifyWire() (signature-only, no notion of `delegation`) sees one more
    // opaque field and verifies it exactly like any other app field.
    expect(await verifyWire(wire)).toBe(true);

    const resolved = await resolveWireSender(wire);
    expect(resolved).toEqual({ id: root.did, leaf: leaf.did, root: root.did, delegated: true });
  });

  it("rejects a wire whose signature was tampered with", async () => {
    const leaf = await createDidIdentity();
    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf);
    const tampered = { ...wire, body: "goodbye" };

    expect(await verifyWire(tampered)).toBe(false);
    expect(await resolveWireSender(tampered)).toBeNull();
  });

  it("rejects a wire whose signature-protected delegation was swapped out", async () => {
    const root = await createDidIdentity();
    const leaf = await createDidIdentity();
    const delegation = await signDelegation(root, leaf.did);
    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf, delegation);

    const otherRoot = await createDidIdentity();
    const swappedDelegation = await signDelegation(otherRoot, leaf.did);
    const tampered = { ...wire, delegation: swappedDelegation };

    // Swapping the delegation invalidates the outer signature (delegation is
    // signed-over), so the wire itself is now invalid, not just "leaf-only".
    expect(await verifyWire(tampered)).toBe(false);
    expect(await resolveWireSender(tampered)).toBeNull();
  });

  it("degrades an expired delegation to the leaf identity instead of failing the message", async () => {
    const root = await createDidIdentity();
    const leaf = await createDidIdentity();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const delegation = await signDelegation(root, leaf.did, { now, ttlMs: 1000 });
    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf, delegation);

    // The wire's own signature is untouched by time — only the embedded
    // delegation has expired relative to `now`.
    expect(await verifyWire(wire)).toBe(true);

    const muchLater = new Date("2026-02-01T00:00:00.000Z");
    const resolved = await resolveWireSender(wire, { now: muchLater });
    expect(resolved).toEqual({ id: leaf.did, leaf: leaf.did, delegated: false });
  });

  it("degrades a delegation whose leaf doesn't match the wire's fromId", async () => {
    const root = await createDidIdentity();
    const leaf = await createDidIdentity();
    const otherLeaf = await createDidIdentity();
    // A delegation for a different leaf, attached to this wire (attacker- or
    // bug-supplied) — the outer signature still checks out because `leaf`
    // signs the whole wire including this field, but the leaf mismatch must
    // still degrade the delegation rather than falsely attributing to root.
    const delegation = await signDelegation(root, otherLeaf.did);
    const wire = await signWireWithDelegation({ fromId: leaf.did, body: "hello" }, leaf, delegation);

    const resolved = await resolveWireSender(wire);
    expect(resolved).toEqual({ id: leaf.did, leaf: leaf.did, delegated: false });
  });
});

// Attaches/resolves a DelegationV1 on a signed wire message (tc-chat:post,
// tc-news:article, ...). See did-delegation.md's "ワイヤへの添付と送信者の解決"
// section — `delegation` rides inside the signed payload (not a sibling
// field outside it), so a receiver that has never heard of delegation chains
// still verifies the wire correctly via plain verifyWire(): it just sees one
// more opaque field to include in the signing payload, exactly like any
// other app-defined field. That's what makes this backward compatible.
import { isEd25519DidKey, signStringWithDidIdentity, verifyStringWithDid, type DidIdentity } from "./didKey.js";
import { verifyDelegation, type DelegationV1 } from "./delegation.js";
import { stableStringify } from "./stableStringify.js";

export type ResolvedSender = {
  /** Identity to use for same-person comparisons: `root` when delegated, else `leaf`. */
  id: string;
  /** Always `wire.fromId` — the key that actually signed this wire. */
  leaf: string;
  /** Present only when the attached delegation verified. */
  root?: string;
  delegated: boolean;
};

function signingPayload(wire: Record<string, unknown>): string {
  const { signature: _signature, ...unsigned } = wire;
  return stableStringify(unsigned);
}

/**
 * Signs every field of `fields` (plus `delegation`, if given) with
 * `identity`, returning the complete wire object including `signature`.
 * `delegation` is inserted BEFORE signing (not appended after) so the
 * signature protects it too — a third party can't strip or swap in a
 * different delegation without invalidating `signature`.
 */
export async function signWireWithDelegation(
  fields: Record<string, unknown> & { fromId: string },
  identity: DidIdentity,
  delegation?: DelegationV1,
): Promise<Record<string, unknown>> {
  if (identity.did !== fields.fromId) {
    throw new Error("wire fromId does not match the local DID identity");
  }
  const wire: Record<string, unknown> = { ...fields };
  delete wire.signature;
  if (delegation) wire.delegation = delegation;
  const signature = await signStringWithDidIdentity(identity, signingPayload(wire));
  return { ...wire, signature };
}

/**
 * Low-level check: verifies `wire.signature` against every other field
 * (including `delegation`, if present) keyed by `wire.fromId`. Identical
 * behavior to existing per-app `verifyWire` implementations (e.g.
 * tc-chat/src/lib/wireSign.ts) — a delegation-unaware caller can keep using
 * this directly and nothing changes for it.
 */
export async function verifyWire(
  wire: Record<string, unknown> & { fromId?: unknown; signature?: unknown },
): Promise<boolean> {
  if (typeof wire.fromId !== "string" || typeof wire.signature !== "string") return false;
  if (!isEd25519DidKey(wire.fromId)) return false;
  try {
    return await verifyStringWithDid(wire.fromId, signingPayload(wire), wire.signature);
  } catch {
    return false;
  }
}

/**
 * Full receive-side resolution per did-delegation.md's "受信側" steps 1-5:
 * verify the wire signature, then — if a `delegation` field is present and
 * verifies for `wire.fromId` as leaf — attribute the sender to `root`.
 * A broken/expired/mismatched delegation degrades to the leaf identity
 * rather than invalidating the message (the wire's own signature already
 * proved authenticity; the delegation only ever adds trust, never removes
 * it). Returns null only when the wire's own signature fails.
 */
export async function resolveWireSender(
  wire: Record<string, unknown>,
  opts?: { now?: Date | number },
): Promise<ResolvedSender | null> {
  if (!(await verifyWire(wire))) return null;
  const fromId = wire.fromId as string;

  if (wire.delegation === undefined) {
    return { id: fromId, leaf: fromId, delegated: false };
  }

  const delegated = await verifyDelegation(wire.delegation, { now: opts?.now, leaf: fromId });
  if (!delegated) {
    return { id: fromId, leaf: fromId, delegated: false };
  }

  const root = (wire.delegation as DelegationV1).root;
  return { id: root, leaf: fromId, root, delegated: true };
}

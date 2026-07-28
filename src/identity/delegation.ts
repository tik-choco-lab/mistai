// DelegationV1: a root did:key's short-lived, signed authorization for a
// leaf did:key to act on its behalf. See
// protocol/docs/data-contracts/docs/did-delegation.md ("DelegationV1" /
// "検証規則" sections) — this file is the canonical implementation that
// section describes; mistl's Rust port (src/identity/delegation.rs)
// independently implements the same spec, so any change here must stay
// byte-compatible with it (signing payload shape, time format, verification
// rules).
import { isEd25519DidKey, signStringWithDidIdentity, verifyStringWithDid, type DidIdentity } from "./didKey.js";
import { stableStringify } from "./stableStringify.js";

export type DelegationV1 = {
  v: 1;
  /** did:key of the root identity (the permanent, cross-origin person id). */
  root: string;
  /** did:key of the delegate (typically an origin-local browser identity). */
  leaf: string;
  /** RFC 3339 UTC, millisecond precision, `Z` suffix — Date#toISOString() verbatim. */
  iat: string;
  /** Same format as `iat`. */
  exp: string;
  /** Ed25519 signature by `root` over delegationSigningPayload(this), base64url (no padding). */
  sig: string;
};

const DEFAULT_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days, per the spec's recommended TTL.
const MAX_TTL_MS = 400 * 24 * 60 * 60 * 1000; // Sanity ceiling (rule 5): forbids "no expiry" delegations.
const CLOCK_SKEW_MS = 5 * 60 * 1000; // Rule 6.

function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function resolveNow(now: Date | number | undefined): number {
  if (now instanceof Date) return now.getTime();
  if (typeof now === "number") return now;
  return Date.now();
}

/** Signing/verification payload: `sig` excluded, key-sorted — always `{"exp":...,"iat":...,"leaf":...,"root":...,"v":1}`. */
export function delegationSigningPayload(d: Omit<DelegationV1, "sig"> & { sig?: string }): string {
  const { sig: _sig, ...unsigned } = d;
  return stableStringify(unsigned);
}

/** Signs a fresh delegation from `rootIdentity` to `leaf`. Default TTL is 60 days (the spec's recommendation). */
export async function signDelegation(
  rootIdentity: DidIdentity,
  leaf: string,
  opts?: { ttlMs?: number; now?: Date | number },
): Promise<DelegationV1> {
  const nowMs = resolveNow(opts?.now);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const unsigned = {
    v: 1 as const,
    root: rootIdentity.did,
    leaf,
    iat: new Date(nowMs).toISOString(),
    exp: new Date(nowMs + ttlMs).toISOString(),
  };
  const sig = await signStringWithDidIdentity(rootIdentity, delegationSigningPayload(unsigned));
  return { ...unsigned, sig };
}

/**
 * Verifies `delegation` against the spec's 8 rules. Structural checks (1-2)
 * come first so a malformed/foreign value fails fast without ever reaching
 * WebCrypto; every rule must pass for this to resolve `true`.
 */
export async function verifyDelegation(
  delegation: unknown,
  opts?: { now?: Date | number; leaf?: string },
): Promise<boolean> {
  if (delegation === null || typeof delegation !== "object") return false;
  const d = delegation as Record<string, unknown>;

  // Rule 1: shape.
  if (d.v !== 1) return false;
  if (typeof d.root !== "string" || typeof d.leaf !== "string") return false;
  if (typeof d.iat !== "string" || typeof d.exp !== "string" || typeof d.sig !== "string") return false;

  // Rule 2: both ends must be well-formed Ed25519 did:keys.
  if (!isEd25519DidKey(d.root) || !isEd25519DidKey(d.leaf)) return false;

  // Rule 3: self-delegation is meaningless.
  if (d.root === d.leaf) return false;

  // Rule 4: parseable, iat < exp.
  const iatMs = toEpochMs(d.iat);
  const expMs = toEpochMs(d.exp);
  if (iatMs === undefined || expMs === undefined) return false;
  if (!(iatMs < expMs)) return false;

  // Rule 5: sanity ceiling on delegation lifetime.
  if (expMs - iatMs > MAX_TTL_MS) return false;

  // Rule 6: clock-skew-tolerant validity window.
  const nowMs = resolveNow(opts?.now);
  if (nowMs < iatMs - CLOCK_SKEW_MS || nowMs > expMs + CLOCK_SKEW_MS) return false;

  // Rule 8: caller-pinned leaf, when given.
  if (opts?.leaf !== undefined && d.leaf !== opts.leaf) return false;

  // Rule 7: signature, checked last since it's the only async/expensive step.
  const payload = delegationSigningPayload({ v: 1, root: d.root, leaf: d.leaf, iat: d.iat, exp: d.exp });
  try {
    return await verifyStringWithDid(d.root, payload, d.sig);
  } catch {
    return false;
  }
}

/** Defensive, signature-free parse of a stored/pasted delegation. Never throws. */
export function parseDelegation(raw: string | null | undefined): DelegationV1 | undefined {
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<DelegationV1>;
    if (
      parsed.v === 1 &&
      typeof parsed.root === "string" &&
      typeof parsed.leaf === "string" &&
      typeof parsed.iat === "string" &&
      typeof parsed.exp === "string" &&
      typeof parsed.sig === "string"
    ) {
      return { v: 1, root: parsed.root, leaf: parsed.leaf, iat: parsed.iat, exp: parsed.exp, sig: parsed.sig };
    }
  } catch {
    // Ignore malformed/foreign payloads — see this file's header: readers never throw.
  }
  return undefined;
}

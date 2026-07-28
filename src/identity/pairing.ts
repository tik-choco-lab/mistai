// Browser side of "経路A: ペアリング" (did-delegation.md) — pairs with a
// waiting `mistl key pair` session over a throwaway mistlib room derived
// from a short human-typed code, and resolves with the DelegationV1 it
// hands back. mistl's Rust port of this exact derivation/protocol lives in
// src/identity/pairing.rs; the two must stay wire-compatible (see the
// cross-implementation test vectors in
// ../__tests__/identity-pairing.test.ts).
//
// The pairing wire messages (`tc-did-pair:*`) are NOT part of protocol.ts's
// ProtocolMessage union — they're app-family-scoped, not LLM-Network-scoped,
// and protocol.ts's decode() would reject them outright (unknown `type`).
// So this file talks to a `MistNodeLike` directly instead of going through
// `Network`, encoding/decoding raw JSON bytes itself.
import { EVENT_RAW, DELIVERY_RELIABLE, type MistNodeLike } from "../node.js";
import { randomId } from "../id.js";
import { bytesToBase64 } from "../base64.js";
import { MistaiError } from "../errors.js";
import { verifyDelegation, type DelegationV1 } from "./delegation.js";
import { stableStringify } from "./stableStringify.js";

// Crockford base32 minus the visually-confusable I/L/O/U (did-delegation.md's "ペアリングコード" section).
const PAIRING_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PAIRING_CODE_LENGTH = 16;

const DEFAULT_PAIRING_TIMEOUT_MS = 60_000;
const DEFAULT_RESEND_INTERVAL_MS = 3_000;

const INVALID_PAIRING_CODE_MESSAGE = "The pairing code is invalid.";
const PAIRING_TIMEOUT_MESSAGE = "Pairing timed out.";
const PAIRING_REJECTED_MESSAGE = "The pairing request was rejected.";
const PAIRING_INVALID_DELEGATION_MESSAGE = "The received delegation is invalid.";
const JOIN_FAILED_MESSAGE = "Failed to join the pairing room.";

export type PairRequest = {
  v: 1;
  type: "tc-did-pair:request";
  leaf: string;
  nonce: string;
  app: string;
  mac: string;
};

export type PairResponse = {
  v: 1;
  type: "tc-did-pair:response";
  nonce: string;
  delegation: DelegationV1;
  mac: string;
};

export type PairError = {
  v: 1;
  type: "tc-did-pair:error";
  nonce: string;
  code: "expired" | "rejected" | "internal";
  message: string;
  mac: string;
};

/**
 * Normalizes a user-typed pairing code: uppercase, then `I`/`L` -> `1` and
 * `O` -> `0` (the alphabet's most likely miskeys), then strips everything
 * not in PAIRING_ALPHABET (hyphens, whitespace, `U`, ...). Returns undefined
 * unless the result is exactly 16 characters — the code is not "probably
 * fine", it's simply invalid.
 */
export function normalizePairingCode(input: string): string | undefined {
  const substituted = input.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  let normalized = "";
  for (const ch of substituted) if (PAIRING_ALPHABET.includes(ch)) normalized += ch;
  return normalized.length === PAIRING_CODE_LENGTH ? normalized : undefined;
}

/** Display form of an already-normalized 16-char code: `XXXX-XXXX-XXXX-XXXX`. */
export function formatPairingCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += 4) groups.push(code.slice(i, i + 4));
  return groups.join("-");
}

/** Mints a fresh 16-char pairing code from 16 cryptographically random bytes (80 bits of entropy). */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return Array.from(bytes, (b) => PAIRING_ALPHABET[b & 0x1f]).join("");
}

async function sha256(text: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

function hexLower(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64UrlNoPad(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** See toArrayBuffer in ./didKey.ts for why this copy exists (WebCrypto needs a real, exactly-sized ArrayBuffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** did-delegation.md "導出" table, room id half: `"tc-did-pair-" + hexLower(sha256(...)).slice(0, 32)`. */
export async function pairingRoomId(code: string): Promise<string> {
  const digest = await sha256(`tc-did-pair-v1|room|${code}`);
  return `tc-did-pair-${hexLower(digest).slice(0, 32)}`;
}

/** did-delegation.md "導出" table, MAC key half: raw 32-byte `sha256(...)`. */
export async function pairingMacKey(code: string): Promise<Uint8Array> {
  return sha256(`tc-did-pair-v1|mac|${code}`);
}

/**
 * `base64url_nopad(HMAC-SHA256(macKey, utf8(stableStringify(msg minus "mac"))))`
 * per did-delegation.md's "メッセージ" section. `msg` is accepted with or
 * without a `mac` field already present — it's always stripped before
 * signing, so the same helper produces AND verifies a MAC.
 */
export async function computePairingMac(msg: Record<string, unknown>, macKey: Uint8Array): Promise<string> {
  const { mac: _mac, ...unsigned } = msg;
  const payload = new TextEncoder().encode(stableStringify(unsigned));
  const key = await crypto.subtle.importKey("raw", toArrayBuffer(macKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  return toBase64UrlNoPad(bytesToBase64(signature));
}

function randomNonceHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return hexLower(bytes);
}

/** Best-effort decode of a raw mist EVENT_RAW payload as a JSON object; never throws. */
function decodeRawJson(payload: unknown): Record<string, unknown> | undefined {
  let bytes: Uint8Array | string | null;
  if (payload instanceof Uint8Array) bytes = payload;
  else if (typeof payload === "string") bytes = payload;
  else if (payload instanceof ArrayBuffer) bytes = new Uint8Array(payload);
  else if (ArrayBuffer.isView(payload)) bytes = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  else {
    try {
      bytes = new Uint8Array(payload as ArrayBufferLike);
    } catch {
      bytes = null;
    }
  }
  if (bytes === null) return undefined;
  try {
    const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface RequestDelegationOptions {
  /** User-typed pairing code (any casing/spacing/hyphenation — normalized internally). */
  code: string;
  /** This browser's leaf did:key, sent to the peer holding the root key. */
  leaf: string;
  /** App name for the peer's confirmation UI (e.g. 'tc-storage'). Not security-relevant. */
  app: string;
  /** Factory for the app's vendored mist node, same shape as Network's. */
  createNode: (nodeId: string) => MistNodeLike;
  /** Overall deadline. Defaults to 60s per did-delegation.md's "タイミングと寿命". */
  timeoutMs?: number;
  /** Request re-broadcast interval (the peer's join may lag ours). Defaults to 3s. */
  resendIntervalMs?: number;
}

/**
 * Runs one pairing session end to end: joins the code-derived room,
 * broadcasts a MAC'd `tc-did-pair:request` every `resendIntervalMs` until a
 * matching, MAC-valid `tc-did-pair:response` or `tc-did-pair:error` arrives
 * (or `timeoutMs` elapses), and resolves with the verified DelegationV1.
 *
 * MAC-invalid messages of any type are discarded silently, per spec — they
 * prove nothing about who sent them, so surfacing them (even as a log) would
 * just be noise an eavesdropper controls. The room is always left and the
 * node's timers/listener are always torn down before this settles, whether
 * it resolves or rejects.
 */
export async function requestDelegation(options: RequestDelegationOptions): Promise<DelegationV1> {
  const code = normalizePairingCode(options.code);
  if (!code) throw new MistaiError("INVALID_PAIRING_CODE", INVALID_PAIRING_CODE_MESSAGE);

  // `createNode` runs synchronously, before any `await`, so a caller that
  // doesn't await this call still observes the node get created immediately
  // (matters for callers/tests that want to reach into the node right away).
  const nonce = randomNonceHex();
  const node = options.createNode(randomId());
  // roomId/macKey derivation is async (SHA-256 via crypto.subtle) and has no
  // observable side effect before it resolves, so it's fine for it to run
  // after node creation instead of before.
  let roomId: string | undefined;
  let macKey: Uint8Array | undefined;

  let settled = false;
  let resendTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    settled = true;
    if (resendTimer !== undefined) clearInterval(resendTimer);
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    try {
      // roomId may still be undefined if cleanup runs before the async setup
      // below ever resolved it (e.g. node.init() rejected immediately) — in
      // that case the node never joined anything, so there's nothing to leave.
      if (roomId !== undefined) node.leaveRoom(roomId);
    } catch {
      // Best-effort — the session is over either way.
    }
  };

  return new Promise<DelegationV1>((resolve, reject) => {
    const finishResolve = (delegation: DelegationV1) => {
      if (settled) return;
      cleanup();
      resolve(delegation);
    };
    const finishReject = (err: unknown) => {
      if (settled) return;
      cleanup();
      reject(err);
    };

    const handleRaw = async (payload: unknown) => {
      if (macKey === undefined) return; // Setup (below) hasn't derived the MAC key yet.
      const msg = decodeRawJson(payload);
      if (!msg || msg.v !== 1 || typeof msg.type !== "string" || typeof msg.mac !== "string") return;
      if (msg.nonce !== nonce) return; // Addressed to a different (or foreign) request.

      const expectedMac = await computePairingMac(msg, macKey);
      // Constant-effort compare is not needed here: the MAC key is derived
      // from a fresh 80-bit code per session, not a long-lived secret worth
      // timing-attacking. A mismatch just means "doesn't know the code" —
      // discard silently, no error, no log (per did-delegation.md).
      if (expectedMac !== msg.mac) return;

      if (msg.type === "tc-did-pair:response") {
        const ok = await verifyDelegation(msg.delegation, { leaf: options.leaf });
        if (!ok) {
          finishReject(new MistaiError("PAIRING_INVALID_DELEGATION", PAIRING_INVALID_DELEGATION_MESSAGE));
          return;
        }
        finishResolve(msg.delegation as DelegationV1);
        return;
      }

      if (msg.type === "tc-did-pair:error") {
        const remoteCode = typeof msg.code === "string" ? msg.code : "internal";
        const remoteMessage = typeof msg.message === "string" && msg.message ? msg.message : PAIRING_REJECTED_MESSAGE;
        finishReject(new MistaiError("PAIRING_REJECTED", remoteMessage, { code: remoteCode }));
      }
    };

    // Armed before any setup work so a `node.init()` that never settles (a
    // wasm node stuck mid-handshake) still hits the deadline instead of
    // leaving the caller waiting forever.
    timeoutTimer = setTimeout(() => {
      finishReject(new MistaiError("PAIRING_TIMEOUT", PAIRING_TIMEOUT_MESSAGE));
    }, options.timeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS);

    node.onEvent((eventType, _fromId, payload) => {
      if (settled || eventType !== EVENT_RAW) return;
      void handleRaw(payload);
    });

    void (async () => {
      try {
        [roomId, macKey] = await Promise.all([pairingRoomId(code), pairingMacKey(code)]);
        await node.init();
      } catch (err) {
        finishReject(new MistaiError("JOIN_FAILED", err instanceof Error ? err.message : JOIN_FAILED_MESSAGE));
        return;
      }
      if (settled) return;
      node.joinRoom(roomId);

      const sendRequest = async () => {
        const request: Omit<PairRequest, "mac"> = { v: 1, type: "tc-did-pair:request", leaf: options.leaf, nonce, app: options.app };
        const mac = await computePairingMac(request, macKey!);
        const bytes = new TextEncoder().encode(JSON.stringify({ ...request, mac }));
        node.sendMessage(null, bytes, DELIVERY_RELIABLE);
      };

      await sendRequest();
      if (settled) return;
      resendTimer = setInterval(() => void sendRequest(), options.resendIntervalMs ?? DEFAULT_RESEND_INTERVAL_MS);
    })();
  });
}

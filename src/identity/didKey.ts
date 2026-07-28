// Ed25519 did:key identity: generation, signing, and verification. Ported
// with identical semantics from tc-storage/src/crypto/didIdentity.ts (the
// canonical implementation shared, by design, with tc-chat and mistl's Rust
// port) — see protocol/docs/data-contracts/docs/did-delegation.md, which
// names this file as one of the two canonical implementations peers must
// interoperate with. Do not "fix" anything here independently of that
// original without noting the divergence.
//
// Unlike tc-storage's original, this file does NOT read/write localStorage
// (loadStoredDidIdentity/ensureDidIdentity) — that's ./store.ts's job here,
// keeping this module a pure crypto/encoding layer usable outside a browser.
import { base64ToBytes, bytesToBase64 } from "../base64.js";

export type PublicDidIdentity = {
  did: string;
  method: "did:key";
  keyType: "Ed25519";
  publicKeyMultibase: string;
  createdAt: string;
};

export type DidIdentity = PublicDidIdentity & {
  privateKeyPkcs8: string;
};

const ed25519Algorithm = { name: "Ed25519" };
const ed25519PublicKeyMulticodec = new Uint8Array([0xed, 0x01]);
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encoder = new TextEncoder();

/** Concatenates byte arrays without relying on any DOM/Node-specific Blob API. */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/**
 * Copies `bytes` into a fresh, exactly-sized ArrayBuffer. WebCrypto's
 * importKey/sign/verify require a real ArrayBuffer, and a Uint8Array decoded
 * from base64 (or otherwise sliced) may be a view over a larger/differently
 * offset buffer than its own length implies.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** Defensive parse of a raw stored identity payload; never throws. */
export function parseStoredDidIdentity(raw: string | null | undefined): DidIdentity | undefined {
  try {
    const parsed = JSON.parse(raw ?? "") as Partial<DidIdentity>;
    if (
      parsed.method === "did:key" &&
      parsed.keyType === "Ed25519" &&
      typeof parsed.did === "string" &&
      typeof parsed.publicKeyMultibase === "string" &&
      typeof parsed.privateKeyPkcs8 === "string" &&
      parsed.did === didKeyFromPublicKeyMultibase(parsed.publicKeyMultibase)
    ) {
      return {
        did: parsed.did,
        method: parsed.method,
        keyType: parsed.keyType,
        publicKeyMultibase: parsed.publicKeyMultibase,
        privateKeyPkcs8: parsed.privateKeyPkcs8,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
      };
    }
  } catch {
    // Ignore invalid or older identity payloads and mint a fresh DID when needed.
  }
  return undefined;
}

export async function createDidIdentity(): Promise<DidIdentity> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto Ed25519 is not available");

  const keyPair = (await subtle.generateKey(ed25519Algorithm, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keyPair.privateKey));
  const publicKeyMultibase = publicKeyMultibaseFromEd25519(publicKeyRaw);
  return {
    did: didKeyFromPublicKeyMultibase(publicKeyMultibase),
    method: "did:key",
    keyType: "Ed25519",
    publicKeyMultibase,
    privateKeyPkcs8: bytesToBase64(privateKeyPkcs8),
    createdAt: new Date().toISOString(),
  };
}

export function publicDidIdentity(identity: DidIdentity): PublicDidIdentity {
  return {
    did: identity.did,
    method: identity.method,
    keyType: identity.keyType,
    publicKeyMultibase: identity.publicKeyMultibase,
    createdAt: identity.createdAt,
  };
}

export async function signStringWithDidIdentity(identity: DidIdentity, payload: string): Promise<string> {
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(base64ToBytes(identity.privateKeyPkcs8)),
    ed25519Algorithm,
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(ed25519Algorithm, privateKey, encoder.encode(payload)));
  return toBase64Url(bytesToBase64(signature));
}

export async function verifyStringWithDid(did: string, payload: string, signature: string): Promise<boolean> {
  const publicKeyRaw = ed25519PublicKeyFromDidKey(did);
  if (!publicKeyRaw) return false;
  const publicKey = await globalThis.crypto.subtle.importKey("raw", toArrayBuffer(publicKeyRaw), ed25519Algorithm, false, ["verify"]);
  return globalThis.crypto.subtle.verify(
    ed25519Algorithm,
    publicKey,
    toArrayBuffer(base64ToBytes(fromBase64Url(signature))),
    encoder.encode(payload),
  );
}

export function publicKeyMultibaseFromEd25519(publicKeyRaw: Uint8Array): string {
  if (publicKeyRaw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return `z${encodeBase58(concatBytes(ed25519PublicKeyMulticodec, publicKeyRaw))}`;
}

export function didKeyFromEd25519PublicKey(publicKeyRaw: Uint8Array): string {
  return didKeyFromPublicKeyMultibase(publicKeyMultibaseFromEd25519(publicKeyRaw));
}

export function didKeyFromPublicKeyMultibase(publicKeyMultibase: string): string {
  ed25519PublicKeyFromMultibase(publicKeyMultibase);
  return `did:key:${publicKeyMultibase}`;
}

export function ed25519PublicKeyFromDidKey(did: string): Uint8Array | undefined {
  if (!did.startsWith("did:key:")) return undefined;
  try {
    return ed25519PublicKeyFromMultibase(did.slice("did:key:".length));
  } catch {
    return undefined;
  }
}

export function isEd25519DidKey(did: string): boolean {
  return ed25519PublicKeyFromDidKey(did) !== undefined;
}

function ed25519PublicKeyFromMultibase(publicKeyMultibase: string): Uint8Array {
  if (!publicKeyMultibase.startsWith("z")) throw new Error("DID key must use base58btc multibase");
  const bytes = decodeBase58(publicKeyMultibase.slice(1));
  if (bytes.length !== 34 || bytes[0] !== ed25519PublicKeyMulticodec[0] || bytes[1] !== ed25519PublicKeyMulticodec[1]) {
    throw new Error("DID key is not an Ed25519 public key");
  }
  return bytes.slice(2);
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let leadingZeroCount = 0;
  while (leadingZeroCount < bytes.length && bytes[leadingZeroCount] === 0) leadingZeroCount += 1;
  if (leadingZeroCount === bytes.length) return base58Alphabet[0].repeat(leadingZeroCount);

  const digits = [0];
  for (let byteIndex = leadingZeroCount; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex];
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = digits[index] * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return base58Alphabet[0].repeat(leadingZeroCount) + digits.reverse().map((digit) => base58Alphabet[digit]).join("");
}

function decodeBase58(value: string): Uint8Array {
  if (!value) return new Uint8Array();
  let leadingZeroCount = 0;
  while (leadingZeroCount < value.length && value[leadingZeroCount] === base58Alphabet[0]) leadingZeroCount += 1;
  if (leadingZeroCount === value.length) return new Uint8Array(leadingZeroCount);

  const bytes = [0];
  for (let charIndex = leadingZeroCount; charIndex < value.length; charIndex += 1) {
    const char = value[charIndex];
    const digit = base58Alphabet.indexOf(char);
    if (digit < 0) throw new Error("Invalid base58btc character");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array([...new Uint8Array(leadingZeroCount), ...bytes.reverse()]);
}

function toBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
}

import { describe, expect, it } from "vitest";
import {
  createDidIdentity,
  didKeyFromEd25519PublicKey,
  ed25519PublicKeyFromDidKey,
  isEd25519DidKey,
  parseStoredDidIdentity,
  publicDidIdentity,
  signStringWithDidIdentity,
  verifyStringWithDid,
} from "../identity/didKey.js";
import { stableStringify } from "../identity/stableStringify.js";

describe("did:key", () => {
  it("round-trips an Ed25519 public key", () => {
    const publicKey = new Uint8Array(32);
    publicKey[0] = 1;
    publicKey[31] = 255;

    const did = didKeyFromEd25519PublicKey(publicKey);

    expect(did).toMatch(/^did:key:z/);
    expect(isEd25519DidKey(did)).toBe(true);
    expect(ed25519PublicKeyFromDidKey(did)).toEqual(publicKey);
  });

  it("rejects non-did:key and non-Ed25519 values", () => {
    expect(isEd25519DidKey("not-a-did")).toBe(false);
    expect(isEd25519DidKey("did:key:znotbase58btc!!!")).toBe(false);
    expect(isEd25519DidKey("did:web:example.com")).toBe(false);
    expect(ed25519PublicKeyFromDidKey("did:key:zInvalid")).toBeUndefined();
  });

  it("creates a fresh identity that signs and verifies payloads", async () => {
    const identity = await createDidIdentity();
    expect(identity.method).toBe("did:key");
    expect(identity.keyType).toBe("Ed25519");
    expect(identity.did).toBe(didKeyFromEd25519PublicKey(ed25519PublicKeyFromDidKey(identity.did)!));

    const signature = await signStringWithDidIdentity(identity, "mistai identity payload");
    expect(await verifyStringWithDid(identity.did, "mistai identity payload", signature)).toBe(true);
    expect(await verifyStringWithDid(identity.did, "tampered payload", signature)).toBe(false);
  });

  it("publicDidIdentity strips the private key", async () => {
    const identity = await createDidIdentity();
    const pub = publicDidIdentity(identity);
    expect(pub).not.toHaveProperty("privateKeyPkcs8");
    expect(pub.did).toBe(identity.did);
  });

  it("parseStoredDidIdentity round-trips a serialized identity and rejects garbage", async () => {
    const identity = await createDidIdentity();
    expect(parseStoredDidIdentity(JSON.stringify(identity))).toEqual(identity);
    expect(parseStoredDidIdentity(null)).toBeUndefined();
    expect(parseStoredDidIdentity("not json")).toBeUndefined();
    expect(parseStoredDidIdentity(JSON.stringify({ ...identity, did: "did:key:zWrongKey" }))).toBeUndefined();
  });
});

describe("stableStringify", () => {
  it("sorts keys deterministically", () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("drops undefined fields", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("recurses into arrays and nested objects", () => {
    expect(stableStringify({ list: [{ z: 1, y: 2 }, 3], n: null })).toBe('{"list":[{"y":2,"z":1},3],"n":null}');
  });
});

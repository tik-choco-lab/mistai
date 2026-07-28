import { describe, expect, it } from "vitest";
import { EVENT_RAW } from "../node.js";
import { createDidIdentity } from "../identity/didKey.js";
import { signDelegation } from "../identity/delegation.js";
import {
  computePairingMac,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  pairingMacKey,
  pairingRoomId,
  requestDelegation,
  type PairError,
  type PairRequest,
  type PairResponse,
} from "../identity/pairing.js";
import { FakeMistNode } from "./fake-node.js";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Polls with real macrotask ticks (unlike fake-node.ts's flushMicrotasks,
 * which only drains microtasks) until `predicate` is true or `timeoutMs`
 * elapses. requestDelegation's internal steps involve real crypto.subtle
 * calls (HMAC signing), which resolve via Node's thread pool — a plain
 * microtask flush isn't guaranteed to wait long enough for those.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("normalizePairingCode / formatPairingCode / generatePairingCode", () => {
  it("uppercases, substitutes I/L->1 and O->0, and strips hyphens/junk", () => {
    // 16 chars once normalized: "abcd-1234-efgh-5678" (lowercase) with an
    // injected 'i'/'l'/'o' that must become '1'/'1'/'0'.
    expect(normalizePairingCode("abcd-1234-efgh-5678")).toBe("ABCD1234EFGH5678");
    expect(normalizePairingCode("aiol-1234-efgh-5678")).toBe("A101" + "1234EFGH5678");
  });

  it("rejects codes that don't normalize to exactly 16 characters", () => {
    expect(normalizePairingCode("ABCD1234")).toBeUndefined();
    expect(normalizePairingCode("ABCD1234EFGH56789")).toBeUndefined();
    // 'U' has no substitution rule and is outside the alphabet, so it's
    // stripped entirely, shortening the result below 16.
    expect(normalizePairingCode("ABCD1234EFGH567U")).toBeUndefined();
  });

  it("formats a normalized code into 4-4-4-4 groups", () => {
    expect(formatPairingCode("ABCD1234EFGH5678")).toBe("ABCD-1234-EFGH-5678");
  });

  it("generates a 16-char code drawn entirely from the pairing alphabet", () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(16);
    expect(normalizePairingCode(code)).toBe(code);
  });
});

describe("pairing derivation — cross-implementation vectors", () => {
  // Fixed vector shared with mistl's Rust port (src/identity/pairing.rs):
  // both implementations must derive the identical roomId/macKey from this
  // exact code, or a browser and mistl can never find each other's room.
  const CODE = "ABCD1234EFGH5678";
  const EXPECTED_ROOM_ID = "tc-did-pair-fb3be94907ec90a4adc84818e0c9a83b";
  const EXPECTED_MAC_KEY_HEX = "daed3202538854e2ee9460abb19fc207a7ba95be8a6d23dcf402fe42617429ef";

  it("derives the documented room id", async () => {
    expect(await pairingRoomId(CODE)).toBe(EXPECTED_ROOM_ID);
  });

  it("derives the documented MAC key", async () => {
    const macKey = await pairingMacKey(CODE);
    expect(macKey).toHaveLength(32);
    expect(bytesToHex(macKey)).toBe(EXPECTED_MAC_KEY_HEX);
  });
});

describe("computePairingMac", () => {
  it("is stable regardless of key order and ignores any existing mac field", async () => {
    const macKey = await pairingMacKey("ABCD1234EFGH5678");
    const msg = { v: 1, type: "tc-did-pair:request", leaf: "did:key:zLeaf", nonce: "abc123", app: "test-app" };
    const reordered = { app: "test-app", nonce: "abc123", leaf: "did:key:zLeaf", type: "tc-did-pair:request", v: 1 };

    const macA = await computePairingMac(msg, macKey);
    const macB = await computePairingMac(reordered, macKey);
    const macC = await computePairingMac({ ...msg, mac: "whatever-was-here-before" }, macKey);
    expect(macA).toBe(macB);
    expect(macA).toBe(macC);
  });

  it("changes when the payload changes", async () => {
    const macKey = await pairingMacKey("ABCD1234EFGH5678");
    const macA = await computePairingMac({ v: 1, nonce: "a" }, macKey);
    const macB = await computePairingMac({ v: 1, nonce: "b" }, macKey);
    expect(macA).not.toBe(macB);
  });
});

describe("requestDelegation", () => {
  const CODE = "ABCD1234EFGH5678";

  async function setup() {
    const root = await createDidIdentity();
    const leaf = await createDidIdentity();
    let node: FakeMistNode | undefined;
    const createNode = (nodeId: string) => {
      node = new FakeMistNode(nodeId);
      return node;
    };
    return { root, leaf, createNode, getNode: () => node! };
  }

  async function firstSentRequest(node: FakeMistNode): Promise<PairRequest & { mac: string }> {
    await waitFor(() => node.sent.length >= 1);
    return JSON.parse(new TextDecoder().decode(node.sent[0].payload));
  }

  it("joins the derived room, broadcasts a MAC'd request, and resolves on a matching response", async () => {
    const { root, leaf, createNode, getNode } = await setup();
    const promise = requestDelegation({
      code: "abcd-1234-efgh-5678", // deliberately unnormalized input
      leaf: leaf.did,
      app: "test-app",
      createNode,
      timeoutMs: 5_000,
      resendIntervalMs: 10_000,
    });

    const node = getNode();
    const request = await firstSentRequest(node);
    expect(request.type).toBe("tc-did-pair:request");
    expect(request.leaf).toBe(leaf.did);
    expect(request.app).toBe("test-app");
    expect(node.joinedRooms).toEqual([await pairingRoomId(CODE)]);

    const macKey = await pairingMacKey(CODE);
    const delegation = await signDelegation(root, leaf.did);
    const response: Omit<PairResponse, "mac"> = { v: 1, type: "tc-did-pair:response", nonce: request.nonce, delegation };
    const mac = await computePairingMac(response, macKey);
    node.emit(EVENT_RAW, "mistl-peer", new TextEncoder().encode(JSON.stringify({ ...response, mac })));

    const resolved = await promise;
    expect(resolved).toEqual(delegation);
    // Must leave the room and stop resending once settled.
    expect(node.leftRooms).toEqual([await pairingRoomId(CODE)]);
  });

  it("ignores a response with an invalid MAC, then resolves once a valid one arrives", async () => {
    const { root, leaf, createNode, getNode } = await setup();
    const promise = requestDelegation({
      code: CODE,
      leaf: leaf.did,
      app: "test-app",
      createNode,
      timeoutMs: 5_000,
      resendIntervalMs: 10_000,
    });

    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );

    const node = getNode();
    const request = await firstSentRequest(node);
    const delegation = await signDelegation(root, leaf.did);

    // Forged response: correct shape, but MAC computed with the wrong key
    // (attacker doesn't know the pairing code).
    const wrongMacKey = await pairingMacKey("ZZZZ9999ZZZZ9999");
    const forged: Omit<PairResponse, "mac"> = { v: 1, type: "tc-did-pair:response", nonce: request.nonce, delegation };
    const forgedMac = await computePairingMac(forged, wrongMacKey);
    node.emit(EVENT_RAW, "attacker", new TextEncoder().encode(JSON.stringify({ ...forged, mac: forgedMac })));
    // Give the (discarded) forged message's async MAC check time to run,
    // then confirm it really didn't settle the promise.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    const macKey = await pairingMacKey(CODE);
    const genuine: Omit<PairResponse, "mac"> = { v: 1, type: "tc-did-pair:response", nonce: request.nonce, delegation };
    const mac = await computePairingMac(genuine, macKey);
    node.emit(EVENT_RAW, "mistl-peer", new TextEncoder().encode(JSON.stringify({ ...genuine, mac })));

    const resolved = await promise;
    expect(resolved).toEqual(delegation);
  });

  it("rejects with PAIRING_REJECTED on a MAC-valid tc-did-pair:error", async () => {
    const { leaf, createNode, getNode } = await setup();
    const promise = requestDelegation({
      code: CODE,
      leaf: leaf.did,
      app: "test-app",
      createNode,
      timeoutMs: 5_000,
      resendIntervalMs: 10_000,
    });

    const node = getNode();
    const request = await firstSentRequest(node);
    const macKey = await pairingMacKey(CODE);
    const error: Omit<PairError, "mac"> = { v: 1, type: "tc-did-pair:error", nonce: request.nonce, code: "rejected", message: "no thanks" };
    const mac = await computePairingMac(error, macKey);
    node.emit(EVENT_RAW, "mistl-peer", new TextEncoder().encode(JSON.stringify({ ...error, mac })));

    await expect(promise).rejects.toMatchObject({ code: "PAIRING_REJECTED" });
  });

  it("rejects with INVALID_PAIRING_CODE before ever touching the network", async () => {
    const { leaf, createNode, getNode } = await setup();
    await expect(
      requestDelegation({ code: "too-short", leaf: leaf.did, app: "test-app", createNode }),
    ).rejects.toMatchObject({ code: "INVALID_PAIRING_CODE" });
    expect(getNode()).toBeUndefined();
  });
});

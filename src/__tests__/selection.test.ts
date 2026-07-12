// Covers the provider-table rework of ConsumerClient: service-based
// eligibility filtering, the three-tier model matching algorithm, random
// tie-break among equally eligible providers, single-retry failover, the
// new 120s default chat timeout, and the backward-compatible ConsumerStatus
// shape (providerId/models preserved, new `providers` array added).

import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumerClient, selectProvider, type ConsumerStatus } from "../client.js";
import { EVENT_PEER_DISCONNECTED, EVENT_RAW } from "../node.js";
import { encode, type LlmRequestMsg } from "../protocol.js";
import { FakeMistNode, flushMicrotasks } from "./fake-node.js";

function makeClient(options: { providerWaitTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const nodes: FakeMistNode[] = [];
  const client = new ConsumerClient({
    createNode: (nodeId) => {
      const node = new FakeMistNode(nodeId);
      nodes.push(node);
      return node;
    },
    ...options,
  });
  return { client, nodes };
}

function chatRequests(node: FakeMistNode): { toId: string | null | undefined; msg: LlmRequestMsg }[] {
  return node
    .sentMessages()
    .filter((s) => s.msg?.type === "llm_request")
    .map((s) => ({ toId: s.toId, msg: s.msg as LlmRequestMsg }));
}

describe("selectProvider (pure matching algorithm)", () => {
  it("narrows to providers announcing the requested service", () => {
    const providers = new Map([
      ["chatOnly", { services: ["chat"] }],
      ["voiceOnly", { services: ["tts", "stt"] }],
    ]);

    expect(selectProvider(providers, "chat", undefined)).toEqual({ providerId: "chatOnly" });
    expect(selectProvider(providers, "tts", undefined)).toEqual({ providerId: "voiceOnly" });
    expect(selectProvider(providers, "stt", undefined)).toEqual({ providerId: "voiceOnly" });
  });

  it("returns null when no provider announces the requested service", () => {
    const providers = new Map([["chatOnly", { services: ["chat"] }]]);
    expect(selectProvider(providers, "tts", undefined)).toBeNull();
  });

  it("branch 1: forwards the model when a provider advertises an exact match", () => {
    const providers = new Map([
      ["A", { models: ["m1", "m2"], services: ["chat"] }],
      ["B", { models: ["m3"], services: ["chat"] }],
    ]);
    expect(selectProvider(providers, "chat", "m1")).toEqual({ providerId: "A", model: "m1" });
  });

  it("branch 2: omits the model for a provider that never advertised a models list", () => {
    const providers = new Map([
      ["A", { models: ["m3"], services: ["chat"] }], // advertises models, but not m1
      ["B", { services: ["chat"] }], // no models list at all
    ]);
    // No provider advertises "m1"; B never advertised a models list at all,
    // so it wins the second tier and the model is omitted (provider default).
    expect(selectProvider(providers, "chat", "m1")).toEqual({ providerId: "B" });
  });

  it("branch 3: best-effort — sends the model anyway when every eligible provider advertised a non-matching list", () => {
    const providers = new Map([
      ["A", { models: ["m3"], services: ["chat"] }],
      ["B", { models: ["m4"], services: ["chat"] }],
    ]);
    const result = selectProvider(providers, "chat", "m1");
    expect(result).not.toBeNull();
    expect(["A", "B"]).toContain(result!.providerId);
    expect(result!.model).toBe("m1");
  });

  it("excludes ids passed via `exclude` (used for failover)", () => {
    const providers = new Map([
      ["A", { services: ["chat"] }],
      ["B", { services: ["chat"] }],
    ]);
    expect(selectProvider(providers, "chat", undefined, new Set(["A"]))).toEqual({ providerId: "B" });
    expect(selectProvider(providers, "chat", undefined, new Set(["A", "B"]))).toBeNull();
  });

  describe("random tie-break", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("picks among equally eligible providers according to Math.random", () => {
      const providers = new Map([
        ["A", { services: ["chat"] }],
        ["B", { services: ["chat"] }],
      ]);

      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(selectProvider(providers, "chat", undefined)?.providerId).toBe("A");

      vi.spyOn(Math, "random").mockReturnValue(0.99);
      expect(selectProvider(providers, "chat", undefined)?.providerId).toBe("B");
    });
  });
});

describe("ConsumerClient service eligibility routing", () => {
  it("does not route a chat request to a voice-only provider", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "voiceOnly", encode({ v: 1, type: "provider_hello", services: ["tts", "stt"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();

    // No eligible chat provider exists yet, so nothing was sent and the
    // request is parked waiting for one.
    expect(chatRequests(node)).toHaveLength(0);

    node.emit(EVENT_RAW, "chatProv", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    await flushMicrotasks();

    const reqs = chatRequests(node);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].toId).toBe("chatProv");

    node.emit(EVENT_RAW, "chatProv", encode({ v: 1, type: "llm_response_done", id: reqs[0].msg.id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });

  it("does not route a TTS request to a chat-only provider", async () => {
    const { client, nodes } = makeClient({ providerWaitTimeoutMs: 30 });
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "chatOnly", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    await expect(client.requestTts("room1", { text: "hi" })).rejects.toThrow("No provider found");
    expect(node.sentMessages().some((s) => s.msg?.type === "tts_request")).toBe(false);
  });
});

describe("ConsumerClient status backward compatibility", () => {
  it("stays in 'connected' with the union of models once a second provider announces itself", async () => {
    const { client, nodes } = makeClient();
    const statuses: ConsumerStatus[] = [];
    client.onStatusChange((s) => statuses.push(s));
    await client.connect("room1");
    const node = nodes[0];

    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", models: ["m1"], services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", models: ["m2"], services: ["chat", "tts"] }));

    expect(client.status).toEqual({
      phase: "connected",
      providerId: "A", // representative: first-announced provider, kept for backward compatibility
      models: ["m1", "m2"],
      providers: [
        { id: "A", models: ["m1"], services: ["chat"] },
        { id: "B", models: ["m2"], services: ["chat", "tts"] },
      ],
    });

    // Never regressed to "searching" while at least one provider remains.
    expect(statuses.some((s) => s.phase === "searching" && statuses.indexOf(s) > 1)).toBe(false);
  });

  it("drops back to 'searching' only once the table is fully empty", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    node.emit(EVENT_PEER_DISCONNECTED, "A", null);
    expect(client.status.phase).toBe("connected");
    if (client.status.phase === "connected") {
      expect(client.status.providers.map((p) => p.id)).toEqual(["B"]);
    }

    node.emit(EVENT_PEER_DISCONNECTED, "B", null);
    expect(client.status).toEqual({ phase: "searching" });
  });
});

describe("ConsumerClient chat default timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("times out a chat request after 120s when requestTimeoutMs is not set", async () => {
    vi.useFakeTimers();
    const { client, nodes } = makeClient();
    await client.connect("room1");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();

    const before = vi.advanceTimersByTimeAsync(119_999);
    await before;
    await flushMicrotasks();

    const after = vi.advanceTimersByTimeAsync(2);
    await expect(promise).rejects.toThrow("timed out");
    await after;
  });

  it("waits indefinitely when requestTimeoutMs is explicitly 0", async () => {
    vi.useFakeTimers();
    const { client, nodes } = makeClient({ requestTimeoutMs: 0 });
    await client.connect("room1");
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello" }));

    let settled = false;
    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(600_000);
    await flushMicrotasks();
    expect(settled).toBe(false);

    const req = chatRequests(nodes[0])[0];
    nodes[0].emit(EVENT_RAW, "prov1", encode({ v: 1, type: "llm_response_done", id: req.msg.id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });
});

describe("ConsumerClient failover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retries once on a different provider when the selected one disconnects, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // deterministic: always pick the first eligible entry
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();

    let reqs = chatRequests(node);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].toId).toBe("A");

    node.emit(EVENT_PEER_DISCONNECTED, "A", null);
    await flushMicrotasks();

    reqs = chatRequests(node);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].toId).toBe("B");

    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "llm_response_done", id: reqs[1].msg.id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });

  it("retries once on request timeout, then succeeds against the other provider", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, nodes } = makeClient({ requestTimeoutMs: 30 });
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();
    expect(chatRequests(node)).toHaveLength(1);

    // Let the 30ms request timeout fire for real (no fake timers here to
    // keep this test simple); A never responds.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const reqs = chatRequests(node);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].toId).toBe("A");
    expect(reqs[1].toId).toBe("B");

    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "llm_response_done", id: reqs[1].msg.id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });

  it("retries once on an unsupported_service error, then succeeds against the other provider", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();

    let reqs = chatRequests(node);
    expect(reqs).toHaveLength(1);
    node.emit(
      EVENT_RAW,
      "A",
      encode({ v: 1, type: "llm_error", id: reqs[0].msg.id, message: "nope", code: "unsupported_service" }),
    );
    await flushMicrotasks();

    reqs = chatRequests(node);
    expect(reqs).toHaveLength(2);
    expect(reqs[1].toId).toBe("B");

    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "llm_response_done", id: reqs[1].msg.id, content: "ok" }));
    await expect(promise).resolves.toBe("ok");
  });

  it("does not retry on a plain upstream error (REMOTE_ERROR without unsupported_service)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();
    const reqs = chatRequests(node);
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "llm_error", id: reqs[0].msg.id, message: "upstream boom" }));

    await expect(promise).rejects.toThrow("upstream boom");
    expect(chatRequests(node)).toHaveLength(1); // no retry was sent
  });

  it("does not retry once streaming has started (a chunk already reached the caller)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));
    node.emit(EVENT_RAW, "B", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const deltas: string[] = [];
    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });
    await flushMicrotasks();
    const reqs = chatRequests(node);

    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "llm_response_chunk", id: reqs[0].msg.id, delta: "He", seq: 0 }));
    expect(deltas).toEqual(["He"]);

    node.emit(EVENT_PEER_DISCONNECTED, "A", null);
    await expect(promise).rejects.toThrow("Connection to the provider was lost");
    expect(chatRequests(node)).toHaveLength(1); // no retry was sent after streaming started
  });

  it("throws the original error when no other eligible provider exists to fail over to", async () => {
    const { client, nodes } = makeClient();
    await client.connect("room1");
    const node = nodes[0];
    node.emit(EVENT_RAW, "A", encode({ v: 1, type: "provider_hello", services: ["chat"] }));

    const promise = client.requestChat("room1", [{ role: "user", content: "hi" }]);
    await flushMicrotasks();
    node.emit(EVENT_PEER_DISCONNECTED, "A", null);

    await expect(promise).rejects.toThrow("Connection to the provider was lost");
    expect(chatRequests(node)).toHaveLength(1);
  });
});

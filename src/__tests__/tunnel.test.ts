// Tests OaiTunnelClient <-> OaiTunnelProvider end to end. The client owns a
// real (fake-transport) Network/session, same as ConsumerClient in
// client.test.ts; the provider is a bare message handler (like ProviderService
// in provider.test.ts), so it's driven directly by feeding it the client's
// FakeMistNode.sentMessages() and feeding its `send` output back into the
// client's node via emit() — simulating the two peers without a real second
// Network/node on the "provider" side.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OaiTunnelClient, OaiTunnelProvider, type OaiUpstream } from "../tunnel.js";
import { EVENT_RAW } from "../node.js";
import { encode, type OaiRequestMsg, type ProtocolMessage } from "../protocol.js";
import { FakeMistNode, flushMicrotasks } from "./fake-node.js";

function makeClient(options: { requestTimeoutMs?: number } = {}) {
  const nodes: FakeMistNode[] = [];
  const client = new OaiTunnelClient({
    createNode: (nodeId) => {
      const node = new FakeMistNode(nodeId);
      nodes.push(node);
      return node;
    },
    nodeIdStorageKey: "test:oai-tunnel-node-id",
    ...options,
  });
  return { client, nodes };
}

/** Provider-side `send` sink: records outgoing messages instead of really transmitting them. */
function makeProviderSink() {
  const sent: { toId: string; msg: ProtocolMessage }[] = [];
  const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });
  return { sent, send };
}

/** Feeds every message a provider sent back to `consumerId` into the client's fake node, as if it arrived from `providerId`. */
function deliverToClient(clientNode: FakeMistNode, providerId: string, sent: { toId: string; msg: ProtocolMessage }[]): void {
  for (const { msg } of sent) clientNode.emit(EVENT_RAW, providerId, encode(msg));
}

describe("OaiTunnelClient <-> OaiTunnelProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("round-trips a request through chunking, a resolver, and a stubbed fetch", async () => {
    const { client, nodes } = makeClient();
    const requestPromise = client.request("room1", {
      path: "/chat/completions",
      body: JSON.stringify({ model: "m1", messages: [] }),
    });
    await flushMicrotasks();

    const clientNode = nodes[0];
    // Announce an oai-capable provider so waitForProvider() resolves.
    clientNode.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", services: ["oai"] }));
    await flushMicrotasks();

    const sentRequests = clientNode
      .sentMessages()
      .filter((s): s is { toId: string | null | undefined; msg: OaiRequestMsg; delivery?: number } => s.msg?.type === "oai_request");
    expect(sentRequests.length).toBeGreaterThan(0);
    expect(sentRequests.every((s) => s.toId === "prov1")).toBe(true);
    expect(sentRequests[0].msg.path).toBe("/chat/completions");
    expect(sentRequests[0].msg.method).toBe("POST");

    const upstream: OaiUpstream = { baseUrl: "https://api.example.com/v1", apiKey: "secret-key" };
    const resolveUpstream = vi.fn((path: string) => (path === "/chat/completions" ? upstream : null));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const { sent: providerSent, send: providerSend } = makeProviderSink();
    const provider = new OaiTunnelProvider(providerSend, resolveUpstream);

    for (const { msg } of sentRequests) {
      expect(provider.handleMessage(clientNode.nodeId, msg)).toBe(true);
    }
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
    expect(JSON.parse(init.body as string)).toEqual({ model: "m1", messages: [] });

    deliverToClient(clientNode, "prov1", providerSent);
    const response = await requestPromise;
    expect(response.status).toBe(200);
    expect(response.contentType).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it("rejects the request without touching fetch when the resolver throws (request_rejected)", async () => {
    const { client, nodes } = makeClient();
    const requestPromise = client.request("room1", { path: "/chat/completions", body: "{}" });
    await flushMicrotasks();

    const clientNode = nodes[0];
    clientNode.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", services: ["oai"] }));
    await flushMicrotasks();

    const fetchMock = vi.spyOn(globalThis, "fetch");
    const resolveUpstream = vi.fn(() => {
      throw new Error("model is not shared by this provider");
    });
    const { sent: providerSent, send: providerSend } = makeProviderSink();
    const provider = new OaiTunnelProvider(providerSend, resolveUpstream);

    const sentRequests = clientNode.sentMessages().filter((s) => s.msg?.type === "oai_request");
    for (const { msg } of sentRequests) provider.handleMessage(clientNode.nodeId, msg as ProtocolMessage);
    await flushMicrotasks();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(providerSent).toEqual([
      {
        toId: clientNode.nodeId,
        msg: { v: 1, type: "oai_error", id: expect.any(String), message: "model is not shared by this provider", code: "request_rejected" },
      },
    ]);

    deliverToClient(clientNode, "prov1", providerSent);
    await expect(requestPromise).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      message: "model is not shared by this provider",
      details: { code: "request_rejected" },
    });
  });

  it("returns unsupported_path when the resolver declines the path (returns null)", async () => {
    const { client, nodes } = makeClient();
    const requestPromise = client.request("room1", { path: "/audio/speech", body: "{}" });
    await flushMicrotasks();

    const clientNode = nodes[0];
    clientNode.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", services: ["oai"] }));
    await flushMicrotasks();

    const { sent: providerSent, send: providerSend } = makeProviderSink();
    const provider = new OaiTunnelProvider(providerSend, () => null);
    const sentRequests = clientNode.sentMessages().filter((s) => s.msg?.type === "oai_request");
    for (const { msg } of sentRequests) provider.handleMessage(clientNode.nodeId, msg as ProtocolMessage);
    await flushMicrotasks();

    deliverToClient(clientNode, "prov1", providerSent);
    await expect(requestPromise).rejects.toMatchObject({
      code: "REMOTE_ERROR",
      details: { code: "unsupported_path" },
    });
  });

  it("times out a request when no oai-capable provider ever announces itself", async () => {
    vi.useFakeTimers();
    const { client, nodes } = makeClient();
    const requestPromise = client.request("room1", { path: "/chat/completions", body: "{}" });
    // Let the join's internal promise chain settle before advancing timers.
    await vi.advanceTimersByTimeAsync(0);
    void nodes; // no provider ever announced

    const assertion = expect(requestPromise).rejects.toMatchObject({ code: "PROVIDER_NOT_FOUND" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("times out an in-flight request if the provider never answers", async () => {
    vi.useFakeTimers();
    const { client, nodes } = makeClient({ requestTimeoutMs: 5_000 });
    const requestPromise = client.request("room1", { path: "/chat/completions", body: "{}" });
    await vi.advanceTimersByTimeAsync(0);

    const clientNode = nodes[0];
    clientNode.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", services: ["oai"] }));
    await vi.advanceTimersByTimeAsync(0);
    // Provider never responds.
    const assertion = expect(requestPromise).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("drops in-flight requests to a provider that disconnects", async () => {
    const { client, nodes } = makeClient();
    const requestPromise = client.request("room1", { path: "/chat/completions", body: "{}" });
    await flushMicrotasks();
    const clientNode = nodes[0];
    clientNode.emit(EVENT_RAW, "prov1", encode({ v: 1, type: "provider_hello", services: ["oai"] }));
    await flushMicrotasks();

    // EVENT_PEER_DISCONNECTED = 6 (see ../node.ts).
    clientNode.emit(6, "prov1", null);
    await expect(requestPromise).rejects.toMatchObject({ code: "PROVIDER_DISCONNECTED" });
  });
});

describe("OaiTunnelProvider.dropPeer", () => {
  it("discards reassembly buffers for the disconnected peer only", () => {
    const { sent, send } = makeProviderSink();
    const provider = new OaiTunnelProvider(send, () => null);
    // First chunk of a two-chunk request from peerA; withheld the final chunk.
    provider.handleMessage("peerA", { v: 1, type: "oai_request", id: "reqA", seq: 0, last: false, data: "AAAA", path: "/models" });
    provider.handleMessage("peerB", { v: 1, type: "oai_request", id: "reqB", seq: 0, last: false, data: "BBBB", path: "/models" });

    provider.dropPeer("peerA");
    // Completing peerA's request now starts a *new* buffer (old one was dropped) rather than resolving.
    provider.handleMessage("peerA", { v: 1, type: "oai_request", id: "reqA", seq: 1, last: true, data: "" });
    expect(sent.some((s) => s.msg.type === "oai_error" && (s.msg as { code?: string }).code === undefined)).toBe(false);
  });
});

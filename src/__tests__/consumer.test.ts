import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumerService } from "../consumer.js";
import type { ProtocolMessage } from "../protocol.js";

describe("ConsumerService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("correlates response chunks/done by request id and assembles deltas", async () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });
    const consumer = new ConsumerService(send);

    const deltas: string[] = [];
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].toId).toBe("providerA");
    const reqMsg = sent[0].msg;
    expect(reqMsg.type).toBe("llm_request");
    const id = (reqMsg as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel" });
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "lo" });
    consumer.handleMessage({ v: 1, type: "llm_response_done", id, content: "Hello" });

    const result = await promise;
    expect(result).toBe("Hello");
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("includes the model in llm_request when given", () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    void consumer.request("providerA", [{ role: "user", content: "hi" }], { model: "gpt-4o" }).catch(() => {});
    expect((sent[0] as { model?: string }).model).toBe("gpt-4o");
  });

  it("rejects the pending request on llm_error", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }]);
    const id = (sent[0] as { id: string }).id;
    consumer.handleMessage({ v: 1, type: "llm_error", id, message: "boom" });
    await expect(promise).rejects.toThrow("boom");
  });

  it("ignores messages with unknown ids", () => {
    const consumer = new ConsumerService(() => {});
    expect(() =>
      consumer.handleMessage({ v: 1, type: "llm_response_chunk", id: "unknown", delta: "x" }),
    ).not.toThrow();
  });

  it("ignores unrelated message types", () => {
    const consumer = new ConsumerService(() => {});
    expect(() => consumer.handleMessage({ v: 1, type: "provider_hello" })).not.toThrow();
  });

  it("falls back to assembled content when done has no content field", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }]);
    const id = (sent[0] as { id: string }).id;
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "abc" });
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });
    await expect(promise).resolves.toBe("abc");
  });

  it("reorders chunks that arrive out of seq order", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const deltas: string[] = [];
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "lo", seq: 1 });
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel", seq: 0 });
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });

    expect(deltas).toEqual(["Hel", "lo"]);
    await expect(promise).resolves.toBe("Hello");
  });

  it("passes through in-order sequenced chunks immediately", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const deltas: string[] = [];
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel", seq: 0 });
    expect(deltas).toEqual(["Hel"]);
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "lo", seq: 1 });
    expect(deltas).toEqual(["Hel", "lo"]);
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });
    await expect(promise).resolves.toBe("Hello");
  });

  it("drops duplicate/stale seq chunks", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const deltas: string[] = [];
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel", seq: 0 });
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel", seq: 0 });
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "lo", seq: 1 });
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });

    expect(deltas).toEqual(["Hel", "lo"]);
    await expect(promise).resolves.toBe("Hello");
  });

  it("applies legacy no-seq chunks immediately in arrival order", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const deltas: string[] = [];
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], {
      onDelta: (d) => deltas.push(d),
    });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "Hel" });
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "lo" });
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });

    expect(deltas).toEqual(["Hel", "lo"]);
    await expect(promise).resolves.toBe("Hello");
  });

  it("rejects with a timeout error and cleans up when nothing arrives in time", async () => {
    vi.useFakeTimers();
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], { timeoutMs: 1000 });
    const id = (sent[0] as { id: string }).id;

    vi.advanceTimersByTime(1000);
    await expect(promise).rejects.toThrow("timed out");

    // Pending entry is cleaned up: a late done must not throw or resolve anything.
    expect(() => consumer.handleMessage({ v: 1, type: "llm_response_done", id, content: "late" })).not.toThrow();
  });

  it("resets the timeout when a chunk arrives (streaming response is alive)", async () => {
    vi.useFakeTimers();
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], { timeoutMs: 1000 });
    const id = (sent[0] as { id: string }).id;

    vi.advanceTimersByTime(800);
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "He", seq: 0 });
    vi.advanceTimersByTime(800); // 1600ms since request, but only 800ms since last chunk
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "y", seq: 1 });
    vi.advanceTimersByTime(999); // still alive
    consumer.handleMessage({ v: 1, type: "llm_response_done", id });

    await expect(promise).resolves.toBe("Hey");
  });

  it("times out relative to the last chunk, not the request start", async () => {
    vi.useFakeTimers();
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("providerA", [{ role: "user", content: "hi" }], { timeoutMs: 1000 });
    const id = (sent[0] as { id: string }).id;

    vi.advanceTimersByTime(500);
    consumer.handleMessage({ v: 1, type: "llm_response_chunk", id, delta: "He", seq: 0 });
    vi.advanceTimersByTime(1000); // 1000ms of silence after the chunk
    await expect(promise).rejects.toThrow("timed out");
  });

  it("rejectAll rejects every in-flight request and clears pending state", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const p1 = consumer.request("providerA", [{ role: "user", content: "one" }]);
    const p2 = consumer.request("providerA", [{ role: "user", content: "two" }]);
    const id1 = (sent[0] as { id: string }).id;

    consumer.rejectAll(new Error("provider gone"));
    await expect(p1).rejects.toThrow("provider gone");
    await expect(p2).rejects.toThrow("provider gone");

    // Cleared: late messages for old ids are ignored.
    expect(() => consumer.handleMessage({ v: 1, type: "llm_response_done", id: id1 })).not.toThrow();
  });
});

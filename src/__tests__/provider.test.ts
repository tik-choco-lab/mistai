import { describe, expect, it, vi } from "vitest";
import { ProviderService, rejectLlmRequest, type ProviderLogEntry } from "../provider.js";
import { ERROR_CODE_UNSUPPORTED_SERVICE } from "../protocol.js";
import type { ProtocolMessage } from "../protocol.js";

describe("ProviderService", () => {
  it("calls the injected LLM function and emits chunk + done messages", async () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });

    const callLlm = vi.fn(async (_messages, _model, onDelta: (d: string) => void) => {
      onDelta("Hel");
      onDelta("lo");
      return "Hello";
    });

    const service = new ProviderService(send, callLlm);
    await service.handleMessage("peerA", {
      v: 1,
      type: "llm_request",
      id: "req1",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(callLlm).toHaveBeenCalledWith([{ role: "user", content: "hi" }], undefined, expect.any(Function));
    expect(sent).toEqual([
      { toId: "peerA", msg: { v: 1, type: "llm_response_chunk", id: "req1", delta: "Hel", seq: 0 } },
      { toId: "peerA", msg: { v: 1, type: "llm_response_chunk", id: "req1", delta: "lo", seq: 1 } },
      { toId: "peerA", msg: { v: 1, type: "llm_response_done", id: "req1", content: "Hello" } },
    ]);
  });

  it("emits llm_error when the LLM call throws", async () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });
    const callLlm = vi.fn(async () => {
      throw new Error("provider offline");
    });

    const service = new ProviderService(send, callLlm);
    await service.handleMessage("peerA", {
      v: 1,
      type: "llm_request",
      id: "req2",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(sent).toEqual([
      { toId: "peerA", msg: { v: 1, type: "llm_error", id: "req2", message: "provider offline" } },
    ]);
  });

  it("ignores non-llm_request messages", async () => {
    const send = vi.fn();
    const callLlm = vi.fn();
    const service = new ProviderService(send, callLlm);
    await service.handleMessage("peerA", { v: 1, type: "consumer_hello" });
    expect(send).not.toHaveBeenCalled();
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("reports progress via onRequestLog including streaming status and charCount", async () => {
    const entries: ProviderLogEntry[] = [];
    const send = () => {};
    const callLlm = async (_m: unknown, _model: unknown, onDelta: (d: string) => void) => {
      onDelta("Hel");
      onDelta("lo");
      return "Hello";
    };
    const service = new ProviderService(send, callLlm, {
      onRequestLog: (entry) => entries.push(entry),
    });
    await service.handleMessage("peerA", {
      v: 1,
      type: "llm_request",
      id: "req3",
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(entries.map((e) => e.status)).toEqual(["started", "streaming", "streaming", "done"]);
    expect(entries.map((e) => e.charCount)).toEqual([0, 3, 5, 5]);
    expect(entries[0].fromId).toBe("peerA");
    expect(entries[0].model).toBe("gpt-4o");
    expect(entries[0].startedAt).toBeTypeOf("number");
  });

  it("logs an error entry with detail when the LLM call throws", async () => {
    const entries: ProviderLogEntry[] = [];
    const service = new ProviderService(
      () => {},
      async () => {
        throw new Error("boom upstream");
      },
      { onRequestLog: (entry) => entries.push(entry) },
    );
    await service.handleMessage("peerA", {
      v: 1,
      type: "llm_request",
      id: "req4",
      messages: [{ role: "user", content: "hi" }],
    });
    const last = entries[entries.length - 1];
    expect(last.status).toBe("error");
    expect(last.detail).toBe("boom upstream");
  });

  it("getLogs returns entries most-recent-first with one entry per request id", async () => {
    const service = new ProviderService(
      () => {},
      async () => "ok",
    );
    for (const id of ["a", "b", "c"]) {
      await service.handleMessage("peer", {
        v: 1,
        type: "llm_request",
        id,
        messages: [{ role: "user", content: "hi" }],
      });
    }
    const logs = service.getLogs();
    expect(logs.map((entry) => entry.id)).toEqual(["c", "b", "a"]);
    expect(logs.every((entry) => entry.status === "done")).toBe(true);
  });

  it("caps retained logs at maxLogEntries, dropping the oldest", async () => {
    const service = new ProviderService(
      () => {},
      async () => "ok",
      { maxLogEntries: 2 },
    );
    for (const id of ["a", "b", "c"]) {
      await service.handleMessage("peer", {
        v: 1,
        type: "llm_request",
        id,
        messages: [{ role: "user", content: "hi" }],
      });
    }
    expect(service.getLogs().map((entry) => entry.id)).toEqual(["c", "b"]);
  });
});

describe("rejectLlmRequest", () => {
  it("sends a code-carrying llm_error for a request this provider cannot answer", () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });

    rejectLlmRequest(send, "peerA", "req1");

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "llm_error",
          id: "req1",
          message: "this provider does not support chat",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });
});

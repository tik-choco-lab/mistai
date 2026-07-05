// Every locally generated failure must be a MistaiError with a stable code,
// so apps can localize by mapping `code` instead of matching English text.

import { describe, expect, it, vi } from "vitest";
import { MistaiError } from "../errors.js";
import { ConsumerService } from "../consumer.js";
import { VoiceConsumerService } from "../voice-consumer.js";
import { fetchModels } from "../openai.js";
import type { ProtocolMessage } from "../protocol.js";

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err instanceof MistaiError ? err.code : undefined;
  }
}

describe("MistaiError codes", () => {
  it("consumer request timeout carries REQUEST_TIMEOUT", async () => {
    vi.useFakeTimers();
    const consumer = new ConsumerService(() => {});
    const promise = consumer.request("p1", [{ role: "user", content: "hi" }], { timeoutMs: 10 });
    promise.catch(() => {}); // avoid unhandled rejection before the assertion awaits it
    vi.advanceTimersByTime(10);
    expect(await codeOf(promise)).toBe("REQUEST_TIMEOUT");
    vi.useRealTimers();
  });

  it("llm_error from the provider carries REMOTE_ERROR", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new ConsumerService((_to, msg) => sent.push(msg));
    const promise = consumer.request("p1", [{ role: "user", content: "hi" }]);
    const id = (sent[0] as { id: string }).id;
    consumer.handleMessage({ v: 1, type: "llm_error", id, message: "boom" });
    expect(await codeOf(promise)).toBe("REMOTE_ERROR");
  });

  it("oversized TTS text carries TTS_TEXT_TOO_LONG", async () => {
    const voice = new VoiceConsumerService(() => {}, { maxTtsTextChars: 4 });
    expect(await codeOf(voice.requestTts("p1", { text: "too long" }))).toBe("TTS_TEXT_TOO_LONG");
  });

  it("fetchModels non-ok response carries UPSTREAM_HTTP_ERROR with status details", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    try {
      await fetchModels({ baseUrl: "https://api.example.com/v1", apiKey: "k" }, fetchFn as unknown as typeof fetch);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MistaiError);
      expect((err as MistaiError).code).toBe("UPSTREAM_HTTP_ERROR");
      expect((err as MistaiError).details).toEqual({ status: 401 });
    }
  });
});

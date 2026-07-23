import { describe, expect, it, vi } from "vitest";
import { streamChatCompletion, fetchModels, fetchVoices, OPENAI_TTS_VOICES } from "../openai.js";

const config = { baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "gpt-4o" };
const messages = [{ role: "user" as const, content: "hello" }];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(chunks: string[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("streamChatCompletion", () => {
  it("sends correct request body/headers and parses non-streaming response", async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test");
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("gpt-4o");
      expect(body.messages).toEqual(messages);
      expect(body.stream).toBe(true);
      expect("temperature" in body).toBe(false);
      expect("reasoning_effort" in body).toBe(false);
      return jsonResponse({ choices: [{ message: { content: "hi there" } }] });
    });

    const onDelta = vi.fn();
    const result = await streamChatCompletion(config, messages, onDelta, fetchFn as unknown as typeof fetch);
    expect(result).toBe("hi there");
    expect(onDelta).toHaveBeenCalledWith("hi there");
  });

  it("includes temperature and reasoning_effort only when configured", async () => {
    const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.temperature).toBe(0.3);
      expect(body.reasoning_effort).toBe("none");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });

    await streamChatCompletion(
      { ...config, temperature: 0.3, reasoningEffort: "none" },
      messages,
      undefined,
      fetchFn as unknown as typeof fetch,
    );
    expect(fetchFn).toHaveBeenCalled();
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.example.com/v1/chat/completions");
      return jsonResponse({ choices: [{ message: { content: "ok" } }] });
    });
    await streamChatCompletion(
      { ...config, baseUrl: "https://api.example.com/v1/" },
      messages,
      undefined,
      fetchFn as unknown as typeof fetch,
    );
  });

  it("parses an SSE stream into deltas", async () => {
    const fetchFn = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"He"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );

    const deltas: string[] = [];
    const result = await streamChatCompletion(
      config,
      messages,
      (d) => deltas.push(d),
      fetchFn as unknown as typeof fetch,
    );
    expect(deltas).toEqual(["He", "llo"]);
    expect(result).toBe("Hello");
  });

  it("throws a clear error on non-ok response", async () => {
    const fetchFn = vi.fn(async () => new Response("bad key", { status: 401 }));
    await expect(
      streamChatCompletion(config, messages, () => {}, fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/401/);
  });

  it("throws a clear error when fetch itself rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(
      streamChatCompletion(config, messages, () => {}, fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/network down/);
  });

  it("throws when the JSON response has no message content", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ choices: [{}] }));
    await expect(
      streamChatCompletion(config, messages, () => {}, fetchFn as unknown as typeof fetch),
    ).rejects.toThrow(/unexpected format/);
  });
});

describe("fetchModels", () => {
  it("sends correct URL and headers, and extracts model ids", async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/models");
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test");
      return jsonResponse({
        data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { notAnId: true }],
      });
    });

    const ids = await fetchModels(config, fetchFn as unknown as typeof fetch);
    expect(ids).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("throws a clear error on non-ok response", async () => {
    const fetchFn = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    await expect(fetchModels(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(/401/);
  });

  it("throws a clear error when fetch itself rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchModels(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(/network down/);
  });

  it("throws on malformed JSON", async () => {
    const fetchFn = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchModels(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when data field is missing or not an array", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ notData: [] }));
    await expect(fetchModels(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(/unexpected format/);
  });

  it("throws when data array has no valid ids", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ data: [{ notAnId: 1 }, "garbage"] }));
    await expect(fetchModels(config, fetchFn as unknown as typeof fetch)).rejects.toThrow(/empty or could not be parsed/);
  });
});

describe("fetchVoices", () => {
  it("uses {baseUrl}/audio/voices first, sending the Authorization header when an apiKey is given", async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/audio/voices");
      expect(init.method).toBe("GET");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test");
      return jsonResponse(["alloy", "verse"]);
    });
    const voices = await fetchVoices("https://api.example.com/v1", "sk-test", fetchFn as unknown as typeof fetch);
    expect(voices).toEqual(["alloy", "verse"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("strips a trailing slash from baseUrl and omits Authorization when no apiKey is given", async () => {
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.example.com/v1/audio/voices");
      expect(init.headers).toEqual({});
      return jsonResponse(["alloy"]);
    });
    const voices = await fetchVoices("https://api.example.com/v1/", undefined, fetchFn as unknown as typeof fetch);
    expect(voices).toEqual(["alloy"]);
  });

  it("falls back to {baseUrl}/voices when /audio/voices fails", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/audio/voices")) return new Response("not found", { status: 404 });
      expect(url).toBe("https://api.example.com/v1/voices");
      return jsonResponse({ voices: ["kokoro-1", "kokoro-2"] });
    });
    const voices = await fetchVoices("https://api.example.com/v1", "sk-test", fetchFn as unknown as typeof fetch);
    expect(voices).toEqual(["kokoro-1", "kokoro-2"]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("falls back to /voices when /audio/voices returns an empty list", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/audio/voices")) return jsonResponse([]);
      return jsonResponse({ data: [{ id: "v1" }, { name: "v2" }, { voice: "v3" }] });
    });
    const voices = await fetchVoices("https://api.example.com/v1", "", fetchFn as unknown as typeof fetch);
    expect(voices).toEqual(["v1", "v2", "v3"]);
  });

  it("tolerates a mixed string/object array, dropping unusable entries", async () => {
    const fetchFn = vi.fn(async () => jsonResponse(["alloy", { id: "coral" }, { garbage: true }, 42, null]));
    const voices = await fetchVoices("https://api.example.com/v1", "", fetchFn as unknown as typeof fetch);
    expect(voices).toEqual(["alloy", "coral"]);
  });

  it("resolves to [] (never throws) when both endpoints 404", async () => {
    const fetchFn = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(fetchVoices("https://api.example.com/v1", "sk-test", fetchFn as unknown as typeof fetch)).resolves.toEqual(
      [],
    );
  });

  it("resolves to [] (never throws) when fetch itself rejects", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(fetchVoices("https://api.example.com/v1", "sk-test", fetchFn as unknown as typeof fetch)).resolves.toEqual(
      [],
    );
  });

  it("resolves to [] (never throws) on malformed JSON", async () => {
    const fetchFn = vi.fn(
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchVoices("https://api.example.com/v1", "sk-test", fetchFn as unknown as typeof fetch)).resolves.toEqual(
      [],
    );
  });

  it("OPENAI_TTS_VOICES is a non-empty static fallback list", () => {
    expect(OPENAI_TTS_VOICES.length).toBeGreaterThan(0);
    expect(OPENAI_TTS_VOICES).toContain("alloy");
  });
});

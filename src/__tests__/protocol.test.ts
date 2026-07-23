import { describe, expect, it } from "vitest";
import { decode, encode } from "../protocol.js";

describe("protocol encode/decode", () => {
  it("round-trips an llm_request", () => {
    const msg = {
      v: 1 as const,
      type: "llm_request" as const,
      id: "abc",
      messages: [{ role: "user" as const, content: "hi" }],
      model: "gpt-4o",
    };
    const decoded = decode(encode(msg));
    expect(decoded).toEqual(msg);
  });

  it("round-trips an llm_response_chunk", () => {
    const msg = { v: 1 as const, type: "llm_response_chunk" as const, id: "abc", delta: "he" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips an llm_response_chunk with seq", () => {
    const msg = { v: 1 as const, type: "llm_response_chunk" as const, id: "abc", delta: "he", seq: 3 };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects llm_response_chunk with a negative seq", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "llm_response_chunk", id: "a", delta: "x", seq: -1 })),
    ).toBeNull();
  });

  it("rejects llm_response_chunk with a non-integer seq", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "llm_response_chunk", id: "a", delta: "x", seq: 1.5 })),
    ).toBeNull();
  });

  it("round-trips an llm_response_done without content", () => {
    const msg = { v: 1 as const, type: "llm_response_done" as const, id: "abc" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips an llm_error", () => {
    const msg = { v: 1 as const, type: "llm_error" as const, id: "abc", message: "boom" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips hello messages", () => {
    expect(decode(encode({ v: 1, type: "provider_hello" }))).toEqual({ v: 1, type: "provider_hello" });
    expect(decode(encode({ v: 1, type: "consumer_hello" }))).toEqual({ v: 1, type: "consumer_hello" });
  });

  it("decodes from a plain string too", () => {
    const msg = { v: 1 as const, type: "consumer_hello" as const };
    expect(decode(JSON.stringify(msg))).toEqual(msg);
  });

  it("rejects malformed JSON", () => {
    expect(decode("not json")).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(decode(JSON.stringify("hello"))).toBeNull();
    expect(decode(JSON.stringify(42))).toBeNull();
    expect(decode(JSON.stringify(null))).toBeNull();
  });

  it("rejects unknown message types", () => {
    expect(decode(JSON.stringify({ v: 1, type: "evil_type" }))).toBeNull();
  });

  it("rejects wrong protocol version", () => {
    expect(decode(JSON.stringify({ v: 2, type: "consumer_hello" }))).toBeNull();
  });

  it("rejects llm_request with missing id", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "llm_request", messages: [{ role: "user", content: "x" }] })),
    ).toBeNull();
  });

  it("rejects llm_request with empty messages", () => {
    expect(decode(JSON.stringify({ v: 1, type: "llm_request", id: "a", messages: [] }))).toBeNull();
  });

  it("rejects llm_request with malicious/malformed message roles", () => {
    expect(
      decode(
        JSON.stringify({
          v: 1,
          type: "llm_request",
          id: "a",
          messages: [{ role: "__proto__", content: "x" }],
        }),
      ),
    ).toBeNull();
  });

  it("rejects llm_request with non-array messages", () => {
    expect(decode(JSON.stringify({ v: 1, type: "llm_request", id: "a", messages: "hack" }))).toBeNull();
  });

  it("rejects llm_response_chunk with non-string delta", () => {
    expect(decode(JSON.stringify({ v: 1, type: "llm_response_chunk", id: "a", delta: 5 }))).toBeNull();
  });

  it("rejects llm_error with missing message", () => {
    expect(decode(JSON.stringify({ v: 1, type: "llm_error", id: "a" }))).toBeNull();
  });

  it("rejects invalid UTF-8-adjacent garbage bytes gracefully", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01]);
    expect(decode(bytes)).toBeNull();
  });

  it("strips unknown fields from known message types", () => {
    const decoded = decode(
      JSON.stringify({ v: 1, type: "llm_error", id: "a", message: "boom", evil: "field" }),
    );
    expect(decoded).toEqual({ v: 1, type: "llm_error", id: "a", message: "boom" });
  });

  it("round-trips raft_message", () => {
    const msg = { v: 1 as const, type: "raft_message" as const, payload: "YmFzZTY0Ym9ndXM=" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects raft_message with empty payload", () => {
    expect(decode(JSON.stringify({ v: 1, type: "raft_message", payload: "" }))).toBeNull();
  });

  it("round-trips provider_hello with models", () => {
    const msg = { v: 1 as const, type: "provider_hello" as const, models: ["gpt-4o", "gpt-4o-mini"] };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("filters non-string entries out of provider_hello models", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "provider_hello", models: ["gpt-4o", 42, null, "m2", {}] })),
    ).toEqual({ v: 1, type: "provider_hello", models: ["gpt-4o", "m2"] });
  });

  it("drops the models field when it is not an array", () => {
    expect(decode(JSON.stringify({ v: 1, type: "provider_hello", models: "gpt-4o" }))).toEqual({
      v: 1,
      type: "provider_hello",
    });
    expect(decode(JSON.stringify({ v: 1, type: "provider_hello", models: 42 }))).toEqual({
      v: 1,
      type: "provider_hello",
    });
  });

  it("round-trips provider_hello with voices", () => {
    const msg = { v: 1 as const, type: "provider_hello" as const, voices: ["alloy", "verse"] };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips provider_hello with models, services, and voices together", () => {
    const msg = {
      v: 1 as const,
      type: "provider_hello" as const,
      models: ["gpt-4o"],
      services: ["chat", "tts"],
      voices: ["alloy", "verse"],
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("filters non-string entries out of provider_hello voices", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "provider_hello", voices: ["alloy", 42, null, "verse", {}, ""] })),
    ).toEqual({ v: 1, type: "provider_hello", voices: ["alloy", "verse"] });
  });

  it("drops the voices field when it is not an array", () => {
    expect(decode(JSON.stringify({ v: 1, type: "provider_hello", voices: "alloy" }))).toEqual({
      v: 1,
      type: "provider_hello",
    });
    expect(decode(JSON.stringify({ v: 1, type: "provider_hello", voices: 42 }))).toEqual({
      v: 1,
      type: "provider_hello",
    });
  });

  it("round-trips a tts_request with optional fields", () => {
    const msg = {
      v: 1 as const,
      type: "tts_request" as const,
      id: "t1",
      text: "こんにちは",
      model: "tts-1",
      voice: "alloy",
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips a bare tts_request", () => {
    const msg = { v: 1 as const, type: "tts_request" as const, id: "t1", text: "hi" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects tts_request with non-string text", () => {
    expect(decode(JSON.stringify({ v: 1, type: "tts_request", id: "t1", text: 5 }))).toBeNull();
  });

  it("round-trips a tts_response", () => {
    const msg = {
      v: 1 as const,
      type: "tts_response" as const,
      id: "t1",
      seq: 0,
      data: "QUJD",
      last: true,
      mime: "audio/mpeg",
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects tts_response with a negative seq", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "tts_response", id: "t1", seq: -1, data: "x", last: true, mime: "audio/mpeg" })),
    ).toBeNull();
  });

  it("rejects tts_response with missing mime", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "tts_response", id: "t1", seq: 0, data: "x", last: true })),
    ).toBeNull();
  });

  it("rejects tts_response with non-boolean last", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "tts_response", id: "t1", seq: 0, data: "x", last: "yes", mime: "audio/mpeg" })),
    ).toBeNull();
  });

  it("round-trips an stt_request with metadata", () => {
    const msg = {
      v: 1 as const,
      type: "stt_request" as const,
      id: "s1",
      seq: 0,
      data: "QUJD",
      last: false,
      mime: "audio/webm",
      model: "whisper-1",
      fileName: "rec.webm",
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects stt_request with a non-integer seq", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "stt_request", id: "s1", seq: 0.5, data: "x", last: true, mime: "audio/webm" })),
    ).toBeNull();
  });

  it("rejects stt_request with missing mime", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "stt_request", id: "s1", seq: 0, data: "x", last: true })),
    ).toBeNull();
  });

  it("round-trips an stt_response", () => {
    const msg = { v: 1 as const, type: "stt_response" as const, id: "s1", text: "hello world" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects stt_response with missing text", () => {
    expect(decode(JSON.stringify({ v: 1, type: "stt_response", id: "s1" }))).toBeNull();
  });

  it("round-trips a voice_error", () => {
    const msg = { v: 1 as const, type: "voice_error" as const, id: "s1", message: "boom" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects voice_error with missing message", () => {
    expect(decode(JSON.stringify({ v: 1, type: "voice_error", id: "s1" }))).toBeNull();
  });

  it("rejects voice_error with empty id", () => {
    expect(decode(JSON.stringify({ v: 1, type: "voice_error", id: "", message: "x" }))).toBeNull();
  });
});

describe("oai_* tunnel protocol extension", () => {
  it("round-trips a bare oai_request (no seq-0 metadata)", () => {
    const msg = { v: 1 as const, type: "oai_request" as const, id: "r1", seq: 1, last: false, data: "QUJD" };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("round-trips an oai_request with seq-0 metadata", () => {
    const msg = {
      v: 1 as const,
      type: "oai_request" as const,
      id: "r1",
      seq: 0,
      last: true,
      data: "QUJD",
      path: "/chat/completions",
      method: "POST",
      contentType: "application/json",
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects oai_request with missing id", () => {
    expect(decode(JSON.stringify({ v: 1, type: "oai_request", seq: 0, last: true, data: "" }))).toBeNull();
  });

  it("rejects oai_request with a negative seq", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: -1, last: true, data: "" })),
    ).toBeNull();
  });

  it("rejects oai_request with non-string data", () => {
    expect(decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: 5 }))).toBeNull();
  });

  it("rejects oai_request with non-boolean last", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: "yes", data: "" })),
    ).toBeNull();
  });

  it("rejects oai_request with a non-string path/method/contentType", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: "", path: 5 })),
    ).toBeNull();
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: "", method: 5 })),
    ).toBeNull();
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: "", contentType: 5 })),
    ).toBeNull();
  });

  it("round-trips an oai_response with seq-0 metadata", () => {
    const msg = {
      v: 1 as const,
      type: "oai_response" as const,
      id: "r1",
      seq: 0,
      last: true,
      data: "QUJD",
      status: 200,
      contentType: "application/json",
    };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it("rejects oai_response with a non-number status", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_response", id: "r1", seq: 0, last: true, data: "", status: "200" })),
    ).toBeNull();
  });

  it("round-trips an oai_error with and without code", () => {
    expect(decode(encode({ v: 1, type: "oai_error", id: "r1", message: "boom" }))).toEqual({
      v: 1,
      type: "oai_error",
      id: "r1",
      message: "boom",
    });
    expect(decode(encode({ v: 1, type: "oai_error", id: "r1", message: "boom", code: "unsupported_path" }))).toEqual({
      v: 1,
      type: "oai_error",
      id: "r1",
      message: "boom",
      code: "unsupported_path",
    });
  });

  it("rejects oai_error with missing message", () => {
    expect(decode(JSON.stringify({ v: 1, type: "oai_error", id: "r1" }))).toBeNull();
  });

  it("strips unknown fields from oai_request just like every other known type", () => {
    expect(
      decode(JSON.stringify({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: "", evil: "field" })),
    ).toEqual({ v: 1, type: "oai_request", id: "r1", seq: 0, last: true, data: "" });
  });
});

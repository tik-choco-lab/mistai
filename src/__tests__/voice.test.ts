import { describe, expect, it, vi } from "vitest";
import { VoiceConsumerService } from "../voice-consumer.js";
import { VoiceProviderService } from "../voice-provider.js";
import { VOICE_CHUNK_SIZE, blobToBase64 } from "../base64.js";
import type { ProtocolMessage, TtsResponseMsg } from "../protocol.js";

function makeAudioBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 7 + 13) % 256;
  return bytes;
}

/** Waits until all currently queued microtasks/promises have settled. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("VoiceConsumerService + VoiceProviderService", () => {
  it("TTS happy path: provider splits audio into chunks, consumer reassembles with mime preserved", async () => {
    // ~20KB of audio -> ~27KB base64 -> 3 chunks of VOICE_CHUNK_SIZE.
    const audioBytes = makeAudioBytes(20_000);
    const synthesize = vi.fn(async () => ({
      blob: new Blob([audioBytes], { type: "audio/wav" }),
      mime: "audio/wav",
    }));

    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService(
      (_toId, msg) => consumer.handleMessage(msg),
      synthesize,
      async () => "unused",
    );
    consumer = new VoiceConsumerService((_toId, msg) => {
      void provider.handleMessage("consumer1", msg);
    });

    const blob = await consumer.requestTts("provider1", { text: "こんにちは", model: "tts-1", voice: "alloy" });

    expect(synthesize).toHaveBeenCalledWith("こんにちは", "tts-1", "alloy", undefined);
    expect(blob.type).toBe("audio/wav");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(audioBytes);
  });

  it("passes lang through consumer -> wire -> provider's synthesize call", async () => {
    const synthesize = vi.fn(async () => ({ blob: new Blob([]), mime: "audio/mpeg" }));

    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService(
      (_toId, msg) => consumer.handleMessage(msg),
      synthesize,
      async () => "unused",
    );
    consumer = new VoiceConsumerService((_toId, msg) => {
      void provider.handleMessage("consumer1", msg);
    });

    await consumer.requestTts("provider1", { text: "hello", model: "tts-1", voice: "alloy", lang: "ja-JP" });

    expect(synthesize).toHaveBeenCalledWith("hello", "tts-1", "alloy", "ja-JP");
  });

  it("omits lang on the wire when not requested, so synthesize receives undefined", async () => {
    const synthesize = vi.fn(async () => ({ blob: new Blob([]), mime: "audio/mpeg" }));
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg));
    const provider = new VoiceProviderService(
      () => {
        /* response delivery is irrelevant to this assertion */
      },
      synthesize,
      async () => "unused",
    );

    const promise = consumer.requestTts("provider1", { text: "hello" });
    await provider.handleMessage("consumer1", sent[0]);

    expect(synthesize).toHaveBeenCalledWith("hello", undefined, undefined, undefined);
    consumer.rejectAll(new Error("test cleanup")); // clears the pending request timer
    await expect(promise).rejects.toThrow("test cleanup");
  });

  it("provider emits multiple ordered tts_response chunks for large audio", async () => {
    const audioBytes = makeAudioBytes(20_000);
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => ({ blob: new Blob([audioBytes], { type: "audio/wav" }), mime: "audio/wav" }),
      async () => "unused",
    );

    await provider.handleMessage("c1", { v: 1, type: "tts_request", id: "t1", text: "hi" });

    const chunks = sent.filter((m): m is TtsResponseMsg => m.type === "tts_response");
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_c, i) => i));
    expect(chunks.slice(0, -1).every((c) => !c.last && c.data.length === VOICE_CHUNK_SIZE)).toBe(true);
    expect(chunks[chunks.length - 1].last).toBe(true);
    expect(chunks.every((c) => c.mime === "audio/wav")).toBe(true);
  });

  it("rejects a TTS response whose chunks arrive out of order", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg));
    const promise = consumer.requestTts("p1", { text: "hi" });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "tts_response", id, seq: 1, data: "QUJD", last: false, mime: "audio/mpeg" });
    await expect(promise).rejects.toThrow("out of order");
  });

  it("rejects oversized TTS text before sending anything", async () => {
    const send = vi.fn();
    const consumer = new VoiceConsumerService(send, { maxTtsTextChars: 10 });
    await expect(consumer.requestTts("p1", { text: "x".repeat(11) })).rejects.toThrow("too long");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a TTS response that exceeds the audio size cap", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg), { maxAudioBase64Chars: 8 });
    const promise = consumer.requestTts("p1", { text: "hi" });
    const id = (sent[0] as { id: string }).id;

    consumer.handleMessage({ v: 1, type: "tts_response", id, seq: 0, data: "AAAAAAAAAAAA", last: false, mime: "audio/mpeg" });
    await expect(promise).rejects.toThrow("maximum allowed size");
  });

  it("rejects the pending TTS request on voice_error", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg));
    const promise = consumer.requestTts("p1", { text: "hi" });
    const id = (sent[0] as { id: string }).id;
    consumer.handleMessage({ v: 1, type: "voice_error", id, message: "upstream down" });
    await expect(promise).rejects.toThrow("upstream down");
  });

  it("STT round-trip: consumer chunks upload, provider reassembles and transcribes", async () => {
    const audioBytes = makeAudioBytes(30_000);
    const audio = new Blob([audioBytes], { type: "audio/webm" });

    const transcribe = vi.fn(async (received: Blob, mime: string) => {
      expect(mime).toBe("audio/webm");
      expect(new Uint8Array(await received.arrayBuffer())).toEqual(audioBytes);
      return "recognized text";
    });

    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService(
      (_toId, msg) => consumer.handleMessage(msg),
      async () => ({ blob: new Blob([]), mime: "audio/mpeg" }),
      transcribe,
    );
    consumer = new VoiceConsumerService((_toId, msg) => {
      void provider.handleMessage("consumer1", msg);
    });

    const text = await consumer.requestStt("provider1", audio, { model: "whisper-1", fileName: "rec.webm" });
    expect(text).toBe("recognized text");
    expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), "audio/webm", "whisper-1", "rec.webm");
  });

  it("caps concurrent STT streams and rejects the overflow with voice_error", async () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const provider = new VoiceProviderService(
      (toId, msg) => sent.push({ toId, msg }),
      async () => ({ blob: new Blob([]), mime: "audio/mpeg" }),
      async () => "text",
      { maxConcurrentSttStreams: 2 },
    );

    // Two open (not-last) uploads occupy the slots.
    await provider.handleMessage("c1", { v: 1, type: "stt_request", id: "s1", seq: 0, data: "QUJD", last: false, mime: "audio/webm" });
    await provider.handleMessage("c2", { v: 1, type: "stt_request", id: "s2", seq: 0, data: "QUJD", last: false, mime: "audio/webm" });
    await provider.handleMessage("c3", { v: 1, type: "stt_request", id: "s3", seq: 0, data: "QUJD", last: false, mime: "audio/webm" });

    expect(sent).toEqual([
      { toId: "c3", msg: { v: 1, type: "voice_error", id: "s3", message: "Too many concurrent STT uploads." } },
    ]);
  });

  it("rejects out-of-order STT upload chunks with voice_error", async () => {
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => ({ blob: new Blob([]), mime: "audio/mpeg" }),
      async () => "text",
    );
    await provider.handleMessage("c1", { v: 1, type: "stt_request", id: "s1", seq: 0, data: "QUJD", last: false, mime: "audio/webm" });
    await provider.handleMessage("c1", { v: 1, type: "stt_request", id: "s1", seq: 2, data: "QUJD", last: true, mime: "audio/webm" });
    expect(sent).toEqual([
      { v: 1, type: "voice_error", id: "s1", message: "STT audio chunk arrived out of order" },
    ]);
  });

  it("dropPeer discards partially received STT uploads from that peer", async () => {
    const transcribe = vi.fn(async () => "text");
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => ({ blob: new Blob([]), mime: "audio/mpeg" }),
      transcribe,
    );
    await provider.handleMessage("c1", { v: 1, type: "stt_request", id: "s1", seq: 0, data: "QUJD", last: false, mime: "audio/webm" });
    provider.dropPeer("c1");
    // Continuing the dropped upload starts a fresh entry expecting seq 0, so seq 1 is out of order.
    await provider.handleMessage("c1", { v: 1, type: "stt_request", id: "s1", seq: 1, data: "QUJD", last: true, mime: "audio/webm" });
    await flush();
    expect(transcribe).not.toHaveBeenCalled();
    expect(sent).toEqual([
      { v: 1, type: "voice_error", id: "s1", message: "STT audio chunk arrived out of order" },
    ]);
  });

  it("provider sends voice_error when synthesize throws", async () => {
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => {
        throw new Error("tts upstream down");
      },
      async () => "text",
    );
    await provider.handleMessage("c1", { v: 1, type: "tts_request", id: "t1", text: "hi" });
    expect(sent).toEqual([{ v: 1, type: "voice_error", id: "t1", message: "tts upstream down" }]);
  });

  it("rejectAll rejects both pending TTS and STT requests", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg));
    const ttsPromise = consumer.requestTts("p1", { text: "hi" });
    const sttPromise = consumer.requestStt("p1", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }));
    await flush(); // let requestStt finish encoding and register its pending entry

    consumer.rejectAll(new Error("Connection to the provider was lost."));
    await expect(ttsPromise).rejects.toThrow("lost");
    await expect(sttPromise).rejects.toThrow("lost");
  });

  it("mime is taken from the first tts_response chunk", async () => {
    const sent: ProtocolMessage[] = [];
    const consumer = new VoiceConsumerService((_toId, msg) => sent.push(msg));
    const promise = consumer.requestTts("p1", { text: "hi" });
    const id = (sent[0] as { id: string }).id;
    const data = await blobToBase64(new Blob([new Uint8Array([1, 2, 3])]));

    consumer.handleMessage({ v: 1, type: "tts_response", id, seq: 0, data, last: false, mime: "audio/ogg" });
    consumer.handleMessage({ v: 1, type: "tts_response", id, seq: 1, data: "", last: true, mime: "audio/mpeg" });
    const blob = await promise;
    expect(blob.type).toBe("audio/ogg");
  });
});

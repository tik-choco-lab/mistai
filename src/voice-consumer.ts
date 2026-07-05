// Consumer-side voice logic: sends tts_request / stt_request and correlates the
// chunked audio responses back to the originating request by id. Non-streaming
// single-shot (unlike ConsumerService). Network I/O is injected for testability.
//
// Ported from tc-translate/src/lib/mistllm/voice-consumer.ts, with the timeout
// and size limits made overridable via options.

import type { ProtocolMessage, TtsRequestMsg, SttRequestMsg } from "./protocol.js";
import { randomId } from "./id.js";
import { base64ToBlob, blobToBase64, chunkBase64 } from "./base64.js";
import { MistaiError } from "./errors.js";

export type SendFn = (toId: string, msg: ProtocolMessage) => void;

// A request must complete within this window; otherwise it's rejected so callers
// (and their UI state) never hang forever if a provider vanishes mid-response.
export const REQUEST_TIMEOUT_MS = 120_000;
// Hard ceiling on reassembled base64 from a single (possibly malicious) provider.
export const MAX_AUDIO_BASE64_CHARS = 24 * 1024 * 1024;
// tts_request text rides in one un-chunked message, so keep it under the mist
// ~16KB-safe ceiling (worst-case ~3 UTF-8 bytes/char plus the JSON envelope).
export const MAX_TTS_TEXT_CHARS = 4000;

export interface VoiceConsumerOptions {
  /** Per-request completion window. Defaults to {@link REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Max reassembled base64 chars per response. Defaults to {@link MAX_AUDIO_BASE64_CHARS}. */
  maxAudioBase64Chars?: number;
  /** Max tts_request text length. Defaults to {@link MAX_TTS_TEXT_CHARS}. */
  maxTtsTextChars?: number;
}

interface PendingTts {
  mime: string;
  parts: string[];
  size: number;
  nextSeq: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (blob: Blob) => void;
  reject: (err: Error) => void;
}

interface PendingStt {
  timer: ReturnType<typeof setTimeout>;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
}

export class VoiceConsumerService {
  private readonly ttsPending = new Map<string, PendingTts>();
  private readonly sttPending = new Map<string, PendingStt>();
  private readonly send: SendFn;
  private readonly requestTimeoutMs: number;
  private readonly maxAudioBase64Chars: number;
  private readonly maxTtsTextChars: number;

  constructor(send: SendFn, options: VoiceConsumerOptions = {}) {
    this.send = send;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.maxAudioBase64Chars = options.maxAudioBase64Chars ?? MAX_AUDIO_BASE64_CHARS;
    this.maxTtsTextChars = options.maxTtsTextChars ?? MAX_TTS_TEXT_CHARS;
  }

  /** Requests speech synthesis from `providerId`; resolves with the assembled audio Blob. */
  requestTts(providerId: string, params: { text: string; model?: string; voice?: string }): Promise<Blob> {
    if (params.text.length > this.maxTtsTextChars) {
      return Promise.reject(new MistaiError("TTS_TEXT_TOO_LONG", "TTS text is too long to send over the network in one message."));
    }
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.ttsPending.delete(id)) reject(new MistaiError("TTS_TIMEOUT", "TTS request timed out."));
      }, this.requestTimeoutMs);
      this.ttsPending.set(id, { mime: "audio/mpeg", parts: [], size: 0, nextSeq: 0, timer, resolve, reject });
      const req: TtsRequestMsg = { v: 1, type: "tts_request", id, text: params.text };
      this.send(providerId, {
        ...req,
        ...(params.model ? { model: params.model } : {}),
        ...(params.voice ? { voice: params.voice } : {}),
      });
    });
  }

  /** Sends `audio` to `providerId` for transcription; resolves with the recognized text. */
  async requestStt(providerId: string, audio: Blob, params: { model?: string; fileName?: string } = {}): Promise<string> {
    const id = randomId();
    const base64 = await blobToBase64(audio);
    const parts = chunkBase64(base64);
    const mime = audio.type || "audio/webm";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.sttPending.delete(id)) reject(new MistaiError("STT_TIMEOUT", "STT request timed out."));
      }, this.requestTimeoutMs);
      this.sttPending.set(id, { timer, resolve, reject });
      parts.forEach((data, index) => {
        const base: SttRequestMsg = {
          v: 1,
          type: "stt_request",
          id,
          seq: index,
          data,
          last: index === parts.length - 1,
          mime,
        };
        const withMeta =
          index === 0
            ? { ...base, ...(params.model ? { model: params.model } : {}), ...(params.fileName ? { fileName: params.fileName } : {}) }
            : base;
        this.send(providerId, withMeta);
      });
    });
  }

  /** Rejects every in-flight request, e.g. when the serving provider disconnects. */
  rejectAll(err: Error): void {
    for (const entry of this.ttsPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.ttsPending.clear();
    for (const entry of this.sttPending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.sttPending.clear();
  }

  /** Feeds an incoming protocol message into request correlation. No-ops for unrelated types. */
  handleMessage(msg: ProtocolMessage): void {
    if (msg.type === "tts_response") {
      const entry = this.ttsPending.get(msg.id);
      if (!entry) return;
      if (msg.seq !== entry.nextSeq) {
        this.ttsPending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.reject(new MistaiError("TTS_OUT_OF_ORDER", "TTS audio chunk arrived out of order."));
        return;
      }
      if (entry.parts.length === 0) entry.mime = msg.mime; // mime is fixed per stream; trust only the first chunk
      entry.size += msg.data.length;
      if (entry.size > this.maxAudioBase64Chars) {
        this.ttsPending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.reject(new MistaiError("TTS_AUDIO_TOO_LARGE", "TTS audio exceeded the maximum allowed size."));
        return;
      }
      entry.parts.push(msg.data);
      entry.nextSeq += 1;
      if (msg.last) {
        this.ttsPending.delete(msg.id);
        clearTimeout(entry.timer);
        try {
          entry.resolve(base64ToBlob(entry.parts.join(""), entry.mime));
        } catch (err) {
          entry.reject(new MistaiError("TTS_DECODE_FAILED", err instanceof Error ? err.message : "Failed to decode TTS audio."));
        }
      }
      return;
    }
    if (msg.type === "stt_response") {
      const entry = this.sttPending.get(msg.id);
      if (!entry) return;
      this.sttPending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg.text);
      return;
    }
    if (msg.type === "voice_error") {
      const tts = this.ttsPending.get(msg.id);
      if (tts) {
        this.ttsPending.delete(msg.id);
        clearTimeout(tts.timer);
        tts.reject(new MistaiError("REMOTE_ERROR", msg.message));
        return;
      }
      const stt = this.sttPending.get(msg.id);
      if (stt) {
        this.sttPending.delete(msg.id);
        clearTimeout(stt.timer);
        stt.reject(new MistaiError("REMOTE_ERROR", msg.message));
      }
    }
  }
}

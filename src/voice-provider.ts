// Provider-side voice logic: reacts to tts_request / stt_request by calling the
// injected synthesize/transcribe functions (the provider's configured upstream)
// and streaming chunked audio / text back to the requester. Network I/O is
// injected so this can be unit-tested without mistlib or real fetch.
//
// Ported from tc-translate/src/lib/mistllm/voice-provider.ts, with the size
// and concurrency limits made overridable via options.

import type { ProtocolMessage, SttRequestMsg, TtsRequestMsg } from "./protocol.js";
import type { ProviderLogEntry } from "./provider.js";
import { base64ToBlob, blobToBase64, chunkBase64 } from "./base64.js";

export type SendFn = (toId: string, msg: ProtocolMessage) => void;
export type SynthesizeFn = (
  text: string,
  model: string | undefined,
  voice: string | undefined,
) => Promise<{ blob: Blob; mime: string }>;
export type TranscribeFn = (
  audio: Blob,
  mime: string,
  model: string | undefined,
  fileName: string | undefined,
) => Promise<string>;

// Peers are untrusted, so cap what a single (malicious or crashing) consumer can
// make the provider buffer: total audio per upload, and concurrent uploads.
export const MAX_AUDIO_BASE64_CHARS = 24 * 1024 * 1024;
export const MAX_CONCURRENT_STT_STREAMS = 16;

export interface VoiceProviderOptions {
  onRequestLog?: (entry: ProviderLogEntry) => void;
  /** Max reassembled base64 chars per upload. Defaults to {@link MAX_AUDIO_BASE64_CHARS}. */
  maxAudioBase64Chars?: number;
  /** Max concurrently buffered STT uploads. Defaults to {@link MAX_CONCURRENT_STT_STREAMS}. */
  maxConcurrentSttStreams?: number;
}

interface IncomingStt {
  fromId: string;
  parts: string[];
  size: number;
  nextSeq: number;
  mime: string;
  model?: string;
  fileName?: string;
}

export class VoiceProviderService {
  private readonly incomingStt = new Map<string, IncomingStt>();
  private readonly send: SendFn;
  private readonly synthesize: SynthesizeFn;
  private readonly transcribe: TranscribeFn;
  private readonly options: VoiceProviderOptions;
  private readonly maxAudioBase64Chars: number;
  private readonly maxConcurrentSttStreams: number;

  constructor(send: SendFn, synthesize: SynthesizeFn, transcribe: TranscribeFn, options: VoiceProviderOptions = {}) {
    this.send = send;
    this.synthesize = synthesize;
    this.transcribe = transcribe;
    this.options = options;
    this.maxAudioBase64Chars = options.maxAudioBase64Chars ?? MAX_AUDIO_BASE64_CHARS;
    this.maxConcurrentSttStreams = options.maxConcurrentSttStreams ?? MAX_CONCURRENT_STT_STREAMS;
  }

  /** Handles a raw incoming protocol message. No-ops for anything but tts_request / stt_request. */
  async handleMessage(fromId: string, msg: ProtocolMessage): Promise<void> {
    if (msg.type === "tts_request") {
      await this.handleTts(fromId, msg);
    } else if (msg.type === "stt_request") {
      await this.handleStt(fromId, msg);
    }
  }

  /** Discards any partially-received STT uploads from a peer that has disconnected. */
  dropPeer(fromId: string): void {
    for (const [id, entry] of this.incomingStt) {
      if (entry.fromId === fromId) this.incomingStt.delete(id);
    }
  }

  private log(entry: ProviderLogEntry): void {
    this.options.onRequestLog?.(entry);
  }

  private async handleTts(fromId: string, msg: TtsRequestMsg): Promise<void> {
    const startedAt = Date.now();
    const model = msg.model ?? "tts";
    this.log({ id: msg.id, fromId, model, status: "started", startedAt, charCount: msg.text.length });
    try {
      const { blob, mime } = await this.synthesize(msg.text, msg.model, msg.voice);
      const parts = chunkBase64(await blobToBase64(blob));
      parts.forEach((data, index) => {
        this.send(fromId, {
          v: 1,
          type: "tts_response",
          id: msg.id,
          seq: index,
          data,
          last: index === parts.length - 1,
          mime,
        });
      });
      this.log({ id: msg.id, fromId, model, status: "done", startedAt, charCount: blob.size });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(fromId, { v: 1, type: "voice_error", id: msg.id, message });
      this.log({ id: msg.id, fromId, model, status: "error", startedAt, charCount: 0, detail: message });
    }
  }

  private async handleStt(fromId: string, msg: SttRequestMsg): Promise<void> {
    let entry = this.incomingStt.get(msg.id);
    if (!entry) {
      if (this.incomingStt.size >= this.maxConcurrentSttStreams) {
        this.send(fromId, { v: 1, type: "voice_error", id: msg.id, message: "Too many concurrent STT uploads." });
        return;
      }
      entry = { fromId, parts: [], size: 0, nextSeq: 0, mime: msg.mime, model: msg.model, fileName: msg.fileName };
      this.incomingStt.set(msg.id, entry);
    }
    if (msg.seq !== entry.nextSeq) {
      this.incomingStt.delete(msg.id);
      this.send(fromId, { v: 1, type: "voice_error", id: msg.id, message: "STT audio chunk arrived out of order" });
      return;
    }
    entry.size += msg.data.length;
    if (entry.size > this.maxAudioBase64Chars) {
      this.incomingStt.delete(msg.id);
      this.send(fromId, { v: 1, type: "voice_error", id: msg.id, message: "STT audio exceeded the maximum allowed size." });
      return;
    }
    entry.parts.push(msg.data);
    entry.nextSeq += 1;
    if (!msg.last) return;

    this.incomingStt.delete(msg.id);
    const startedAt = Date.now();
    const model = entry.model ?? "stt";
    this.log({ id: msg.id, fromId, model, status: "started", startedAt, charCount: 0 });
    try {
      const audio = base64ToBlob(entry.parts.join(""), entry.mime);
      const text = await this.transcribe(audio, entry.mime, entry.model, entry.fileName);
      this.send(fromId, { v: 1, type: "stt_response", id: msg.id, text });
      this.log({ id: msg.id, fromId, model, status: "done", startedAt, charCount: text.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(fromId, { v: 1, type: "voice_error", id: msg.id, message });
      this.log({ id: msg.id, fromId, model, status: "error", startedAt, charCount: 0, detail: message });
    }
  }
}

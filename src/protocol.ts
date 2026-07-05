// Wire protocol (v: 1) for LLM requests/responses exchanged over the mist
// network. Peers are untrusted, so decode() validates shape before anything
// downstream touches the payload.
//
// Unified from tc-mistllm/src/lib/protocol.ts (source of truth for the base
// wire format, incl. raft_message) and tc-translate/src/lib/mistllm/protocol.ts
// (voice extensions), plus the provider_hello.models extension from
// tc-pdf-viewer/src/services/mistllm.js.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequestMsg {
  v: 1;
  type: "llm_request";
  id: string;
  messages: ChatMessage[];
  model?: string;
}

export interface LlmResponseChunkMsg {
  v: 1;
  type: "llm_response_chunk";
  id: string;
  delta: string;
  /** 0-based, per-request, monotonically increasing. Absent means legacy/unordered delivery. */
  seq?: number;
}

export interface LlmResponseDoneMsg {
  v: 1;
  type: "llm_response_done";
  id: string;
  content?: string;
}

export interface LlmErrorMsg {
  v: 1;
  type: "llm_error";
  id: string;
  message: string;
}

export interface ProviderHelloMsg {
  v: 1;
  type: "provider_hello";
  /**
   * Optional, backward-compatible extension: model ids the provider's
   * upstream offers. Older peers omit it; consumers treat absence as
   * "unknown list".
   */
  models?: string[];
}

export interface ConsumerHelloMsg {
  v: 1;
  type: "consumer_hello";
}

/**
 * Carries one opaque, already-serialized `mistlib_consensus_core::RaftMessage`
 * (base64-encoded bincode bytes) between scheduler-enabled consumer nodes.
 * Only the Rust CLI's scheduler.rs decodes `payload` — this side just
 * transports it unchanged, matching cli/src/protocol.rs's `RaftMessage`.
 */
export interface RaftMessageMsg {
  v: 1;
  type: "raft_message";
  payload: string;
}

export interface TtsRequestMsg {
  v: 1;
  type: "tts_request";
  id: string;
  text: string;
  model?: string;
  voice?: string;
}

/** Audio flows provider->consumer in ordered chunks; `last` marks the final one. */
export interface TtsResponseMsg {
  v: 1;
  type: "tts_response";
  id: string;
  seq: number;
  data: string; // base64 sub-chunk
  last: boolean;
  mime: string;
}

/** Audio flows consumer->provider in ordered chunks; model/fileName ride on seq 0. */
export interface SttRequestMsg {
  v: 1;
  type: "stt_request";
  id: string;
  seq: number;
  data: string; // base64 sub-chunk
  last: boolean;
  mime: string;
  model?: string;
  fileName?: string;
}

export interface SttResponseMsg {
  v: 1;
  type: "stt_response";
  id: string;
  text: string;
}

/** Shared error for both tts_* and stt_* request correlation. */
export interface VoiceErrorMsg {
  v: 1;
  type: "voice_error";
  id: string;
  message: string;
}

export type ProtocolMessage =
  | LlmRequestMsg
  | LlmResponseChunkMsg
  | LlmResponseDoneMsg
  | LlmErrorMsg
  | ProviderHelloMsg
  | ConsumerHelloMsg
  | RaftMessageMsg
  | TtsRequestMsg
  | TtsResponseMsg
  | SttRequestMsg
  | SttResponseMsg
  | VoiceErrorMsg;

const MESSAGE_TYPES = new Set([
  "llm_request",
  "llm_response_chunk",
  "llm_response_done",
  "llm_error",
  "provider_hello",
  "consumer_hello",
  "raft_message",
  "tts_request",
  "tts_response",
  "stt_request",
  "stt_response",
  "voice_error",
]);

const ROLES = new Set(["system", "user", "assistant"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isValidSeq(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.role === "string" && ROLES.has(m.role) && typeof m.content === "string";
}

/** Encodes a protocol message to a JSON UTF-8 byte payload for sendMessage(). */
export function encode(msg: ProtocolMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(msg));
}

/**
 * Decodes and validates bytes/text received from a peer. Returns null for
 * anything that doesn't match the expected shape — callers must never trust
 * peer-supplied data.
 */
export function decode(data: Uint8Array | string): ProtocolMessage | null {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else {
    try {
      text = new TextDecoder().decode(data);
    } catch {
      return null;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;

  if (m.v !== 1) return null;
  if (typeof m.type !== "string" || !MESSAGE_TYPES.has(m.type)) return null;

  switch (m.type) {
    case "provider_hello": {
      // `models` is a backward-compatible optional extension. An invalid
      // `models` value drops just that field rather than rejecting the whole
      // message, so a misbehaving/future peer can't take down provider
      // discovery over an optional extension. Non-string entries are filtered.
      if (Array.isArray(m.models)) {
        const models = m.models.filter((entry): entry is string => typeof entry === "string");
        return { v: 1, type: "provider_hello", models };
      }
      return { v: 1, type: "provider_hello" };
    }
    case "consumer_hello":
      return { v: 1, type: "consumer_hello" };
    case "llm_request": {
      if (!isNonEmptyString(m.id)) return null;
      if (!Array.isArray(m.messages) || m.messages.length === 0) return null;
      if (!m.messages.every(isChatMessage)) return null;
      if (m.model !== undefined && typeof m.model !== "string") return null;
      const req: LlmRequestMsg = {
        v: 1,
        type: "llm_request",
        id: m.id,
        messages: m.messages as ChatMessage[],
      };
      return m.model !== undefined ? { ...req, model: m.model as string } : req;
    }
    case "llm_response_chunk": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.delta !== "string") return null;
      if (m.seq !== undefined && !isValidSeq(m.seq)) return null;
      const chunk: LlmResponseChunkMsg = { v: 1, type: "llm_response_chunk", id: m.id, delta: m.delta };
      return m.seq !== undefined ? { ...chunk, seq: m.seq } : chunk;
    }
    case "llm_response_done": {
      if (!isNonEmptyString(m.id)) return null;
      if (m.content !== undefined && typeof m.content !== "string") return null;
      const done: LlmResponseDoneMsg = { v: 1, type: "llm_response_done", id: m.id };
      return m.content !== undefined ? { ...done, content: m.content as string } : done;
    }
    case "llm_error": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.message !== "string") return null;
      return { v: 1, type: "llm_error", id: m.id, message: m.message };
    }
    case "raft_message": {
      if (!isNonEmptyString(m.payload)) return null;
      return { v: 1, type: "raft_message", payload: m.payload };
    }
    case "tts_request": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.text !== "string") return null;
      if (m.model !== undefined && typeof m.model !== "string") return null;
      if (m.voice !== undefined && typeof m.voice !== "string") return null;
      const req: TtsRequestMsg = { v: 1, type: "tts_request", id: m.id, text: m.text };
      return {
        ...req,
        ...(m.model !== undefined ? { model: m.model as string } : {}),
        ...(m.voice !== undefined ? { voice: m.voice as string } : {}),
      };
    }
    case "tts_response": {
      if (!isNonEmptyString(m.id)) return null;
      if (!isValidSeq(m.seq)) return null;
      if (typeof m.data !== "string") return null;
      if (typeof m.last !== "boolean") return null;
      if (!isNonEmptyString(m.mime)) return null;
      return { v: 1, type: "tts_response", id: m.id, seq: m.seq, data: m.data, last: m.last, mime: m.mime };
    }
    case "stt_request": {
      if (!isNonEmptyString(m.id)) return null;
      if (!isValidSeq(m.seq)) return null;
      if (typeof m.data !== "string") return null;
      if (typeof m.last !== "boolean") return null;
      if (!isNonEmptyString(m.mime)) return null;
      if (m.model !== undefined && typeof m.model !== "string") return null;
      if (m.fileName !== undefined && typeof m.fileName !== "string") return null;
      const req: SttRequestMsg = { v: 1, type: "stt_request", id: m.id, seq: m.seq, data: m.data, last: m.last, mime: m.mime };
      return {
        ...req,
        ...(m.model !== undefined ? { model: m.model as string } : {}),
        ...(m.fileName !== undefined ? { fileName: m.fileName as string } : {}),
      };
    }
    case "stt_response": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.text !== "string") return null;
      return { v: 1, type: "stt_response", id: m.id, text: m.text };
    }
    case "voice_error": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.message !== "string") return null;
      return { v: 1, type: "voice_error", id: m.id, message: m.message };
    }
    default:
      return null;
  }
}

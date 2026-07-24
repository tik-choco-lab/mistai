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
  /**
   * Optional, backward-compatible machine-readable reason. Known value:
   * `"unsupported_service"` (the peer does not provide this service at all,
   * as opposed to an upstream failure).
   */
  code?: string;
}

/**
 * Service names a provider can announce in `provider_hello.services`.
 * The wire field stays `string[]` so future service names pass through;
 * consumers should match against these known names and ignore the rest.
 */
export type KnownService = "chat" | "tts" | "stt" | "embedding" | "oai";

/** provider_hello.services marker: this peer will tunnel OpenAI-compatible HTTP requests (see oai_* below). */
export const OAI_TUNNEL_SERVICE = "oai";

/**
 * What a `provider_hello` without `services` means: peers predating the
 * extension are all chat providers (voice-capable peers must announce it).
 */
export const DEFAULT_PROVIDER_SERVICES: readonly string[] = ["chat"];

/** Known `code` value for capability-mismatch `llm_error` / `voice_error`. */
export const ERROR_CODE_UNSUPPORTED_SERVICE = "unsupported_service";

export interface ProviderHelloMsg {
  v: 1;
  type: "provider_hello";
  /**
   * Optional, backward-compatible extension: model ids the provider's
   * upstream offers. Older peers omit it; consumers treat absence as
   * "unknown list".
   */
  models?: string[];
  /**
   * Optional, backward-compatible extension: which services this provider
   * answers ("chat" | "tts" | "stt" | "embedding"). Absence means
   * `DEFAULT_PROVIDER_SERVICES` (legacy chat-only peer) — see helloServices().
   */
  services?: string[];
  /**
   * Optional, backward-compatible extension: TTS voice names this provider's
   * upstream accepts (a catalog advertisement, meaningful only alongside
   * `services` including `"tts"`). Each entry is an opaque string passed
   * straight through to `tts_request.voice` — unlike `models`, there's no
   * label/id split here since the provider forwards the value verbatim
   * upstream. Absent when the provider couldn't determine its own voice list.
   */
  voices?: string[];
}

/** Resolves the effective service list of a hello, applying the legacy default. */
export function helloServices(msg: ProviderHelloMsg): readonly string[] {
  return msg.services ?? DEFAULT_PROVIDER_SERVICES;
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
  /**
   * Optional, backward-compatible extension: a BCP-47 language tag hinting
   * the upstream's target language for synthesis. Purely advisory — a
   * provider that doesn't understand it ignores it. An invalid (non-string
   * or empty) value just drops the field rather than rejecting the whole
   * message, same as provider_hello's optional extensions.
   */
  lang?: string;
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
  /** Optional machine-readable reason; see LlmErrorMsg.code. */
  code?: string;
}

// Tunnels an OpenAI-compatible HTTP request/response pair over a mist room:
// a consumer sends path+method+body, a provider peer forwards it to its own
// upstream (with its own API key, never the consumer's) and relays the
// response back. Bodies are carried as base64 chunks so anything survives
// the JSON wire envelope; request/response metadata (path, method, status,
// contentType) rides on the seq 0 chunk only, mirroring stt_request's
// `model`/`fileName` convention above. See ./tunnel.ts for the client/
// provider logic built on this wire shape.
//
// Ported from tc-translate/src/lib/p2p/protocol.ts, where it was an
// app-level extension decoded by a separate decodeExtended(); now native so
// every consumer of this library's decode() understands it for free.
export interface OaiRequestMsg {
  v: 1;
  type: "oai_request";
  id: string;
  seq: number;
  last: boolean;
  /** Base64 chunk of the UTF-8 request body; may be '' for an empty/no body. */
  data: string;
  // The following ride on seq 0 only.
  path?: string;
  method?: string;
  contentType?: string;
}

export interface OaiResponseMsg {
  v: 1;
  type: "oai_response";
  id: string;
  seq: number;
  last: boolean;
  /** Base64 chunk of the UTF-8 response body; may be '' for an empty body. */
  data: string;
  // The following ride on seq 0 only.
  status?: number;
  contentType?: string;
}

/** Correlates to the request `id`; sent instead of any oai_response chunks. */
export interface OaiErrorMsg {
  v: 1;
  type: "oai_error";
  id: string;
  message: string;
  /** Optional machine-readable reason, e.g. "unsupported_path" | "request_rejected" | "request_too_large". */
  code?: string;
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
  | VoiceErrorMsg
  | OaiRequestMsg
  | OaiResponseMsg
  | OaiErrorMsg;

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
  "oai_request",
  "oai_response",
  "oai_error",
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
      // `models` / `services` are backward-compatible optional extensions.
      // An invalid value drops just that field rather than rejecting the
      // whole message, so a misbehaving/future peer can't take down provider
      // discovery over an optional extension. Non-string entries are filtered.
      const hello: ProviderHelloMsg = { v: 1, type: "provider_hello" };
      if (Array.isArray(m.models)) {
        hello.models = m.models.filter(isNonEmptyString);
      }
      if (Array.isArray(m.services)) {
        hello.services = m.services.filter(isNonEmptyString);
      }
      if (Array.isArray(m.voices)) {
        hello.voices = m.voices.filter(isNonEmptyString);
      }
      return hello;
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
      // `code` is an optional extension: an invalid value drops the field,
      // never the error itself (losing the error would be worse).
      const err: LlmErrorMsg = { v: 1, type: "llm_error", id: m.id, message: m.message };
      return typeof m.code === "string" ? { ...err, code: m.code } : err;
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
        ...(isNonEmptyString(m.lang) ? { lang: m.lang } : {}),
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
      const err: VoiceErrorMsg = { v: 1, type: "voice_error", id: m.id, message: m.message };
      return typeof m.code === "string" ? { ...err, code: m.code } : err;
    }
    case "oai_request": {
      if (!isNonEmptyString(m.id)) return null;
      if (!isValidSeq(m.seq)) return null;
      if (typeof m.data !== "string") return null;
      if (typeof m.last !== "boolean") return null;
      if (m.path !== undefined && typeof m.path !== "string") return null;
      if (m.method !== undefined && typeof m.method !== "string") return null;
      if (m.contentType !== undefined && typeof m.contentType !== "string") return null;
      const req: OaiRequestMsg = { v: 1, type: "oai_request", id: m.id, seq: m.seq, last: m.last, data: m.data };
      return {
        ...req,
        ...(m.path !== undefined ? { path: m.path as string } : {}),
        ...(m.method !== undefined ? { method: m.method as string } : {}),
        ...(m.contentType !== undefined ? { contentType: m.contentType as string } : {}),
      };
    }
    case "oai_response": {
      if (!isNonEmptyString(m.id)) return null;
      if (!isValidSeq(m.seq)) return null;
      if (typeof m.data !== "string") return null;
      if (typeof m.last !== "boolean") return null;
      if (m.status !== undefined && typeof m.status !== "number") return null;
      if (m.contentType !== undefined && typeof m.contentType !== "string") return null;
      const res: OaiResponseMsg = { v: 1, type: "oai_response", id: m.id, seq: m.seq, last: m.last, data: m.data };
      return {
        ...res,
        ...(m.status !== undefined ? { status: m.status as number } : {}),
        ...(m.contentType !== undefined ? { contentType: m.contentType as string } : {}),
      };
    }
    case "oai_error": {
      if (!isNonEmptyString(m.id)) return null;
      if (typeof m.message !== "string") return null;
      const err: OaiErrorMsg = { v: 1, type: "oai_error", id: m.id, message: m.message };
      return typeof m.code === "string" ? { ...err, code: m.code } : err;
    }
    default:
      return null;
  }
}

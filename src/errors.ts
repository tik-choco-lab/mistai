// Stable error codes for every failure this library generates locally, so
// apps can localize user-facing messages by mapping `code` instead of
// matching the (English) default message strings. Errors relayed from a
// remote provider (`llm_error` / `voice_error`) carry code "REMOTE_ERROR"
// with the provider's original message text, which is written in whatever
// language that provider runs in.

export type MistaiErrorCode =
  | "NO_ROOM_ID"
  | "JOIN_FAILED"
  | "PROVIDER_NOT_FOUND"
  | "PROVIDER_DISCONNECTED"
  | "REQUEST_TIMEOUT"
  | "TTS_TEXT_TOO_LONG"
  | "TTS_TIMEOUT"
  | "STT_TIMEOUT"
  | "TTS_OUT_OF_ORDER"
  | "TTS_AUDIO_TOO_LARGE"
  | "TTS_DECODE_FAILED"
  | "REMOTE_ERROR"
  | "UPSTREAM_REQUEST_FAILED"
  | "UPSTREAM_HTTP_ERROR"
  | "UPSTREAM_BAD_RESPONSE"
  | "MODEL_LIST_EMPTY"
  | "ENDPOINT_NOT_CONFIGURED";

export class MistaiError extends Error {
  readonly code: MistaiErrorCode;
  /** Interpolation values for localized messages (e.g. `{ status: 401 }`). */
  readonly details?: Record<string, unknown>;

  constructor(code: MistaiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MistaiError";
    this.code = code;
    this.details = details;
  }
}

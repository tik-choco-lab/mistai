// Public entry point for @tik-choco/mistai. Everything an app needs to act
// as an LLM Network consumer or provider, minus the transport: the mistlib
// node (or any compatible transport) is injected by the app.

export * from "./errors.js";
export * from "./protocol.js";
export * from "./base64.js";
export * from "./id.js";

export {
  ConsumerService,
  type ConsumerRequestOptions,
  type PendingRequest,
  type SendFn,
} from "./consumer.js";

export {
  ProviderService,
  DEFAULT_MAX_LOG_ENTRIES,
  type LlmCallFn,
  type ProviderLogEntry,
  type ProviderLogOptions,
  type ProviderLogStatus,
} from "./provider.js";

export {
  VoiceConsumerService,
  REQUEST_TIMEOUT_MS,
  MAX_AUDIO_BASE64_CHARS,
  MAX_TTS_TEXT_CHARS,
  type VoiceConsumerOptions,
} from "./voice-consumer.js";

export {
  VoiceProviderService,
  MAX_CONCURRENT_STT_STREAMS,
  type SynthesizeFn,
  type TranscribeFn,
  type VoiceProviderOptions,
} from "./voice-provider.js";

export * from "./openai.js";
export * from "./node.js";
export * from "./client.js";

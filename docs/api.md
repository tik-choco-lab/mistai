# API reference

Four entry points. `@tik-choco/mistai` is the core; the rest are opt-in subpaths so nothing drags
in preact or storage-shaped helpers you didn't ask for.

| Import | Contents |
| --- | --- |
| `@tik-choco/mistai` | protocol, consumer/provider services, voice, OpenAI client, tunnel, node facade |
| `@tik-choco/mistai/preact` | hooks, status/log UI components, the shared settings screen |
| `@tik-choco/mistai/llm-config` | the cross-app shared LLM configuration in localStorage |
| `@tik-choco/mistai/identity` | DID delegation chains — see [`identity.md`](identity.md) |

## `@tik-choco/mistai`

- **protocol** — `encode(msg)` / `decode(bytes|string)`, every message interface, the
  `ProtocolMessage` union, `ChatMessage`.
- **base64** — `blobToBase64` / `base64ToBlob` / `chunkBase64` / `VOICE_CHUNK_SIZE` (12 KB), plus
  the byte/text-level primitives they're built on: `bytesToBase64` / `base64ToBytes` /
  `utf8ToBase64` / `base64ToUtf8`. `blobToBase64` does not use FileReader (works in Node too).
- **messages** — `MistaiMessages` catalogs `MESSAGES_EN` / `MESSAGES_JA` (canonical status labels
  plus one message per error code) and `formatMistaiError(err, messages, fallback?)` /
  `formatMistaiCode(code, messages)`.
- **id** — `randomId()` (UUID that also works outside secure contexts),
  `getPersistentNodeId(storageKey = "mistai:node-id")` (falls back to memory when localStorage is
  unavailable; never throws).
- **consumer** — `ConsumerService(send)`.
  `request(providerId, messages, { model?, onDelta?, timeoutMs? })` handles seq reordering,
  duplicate dropping, and legacy no-seq senders. With `timeoutMs` set, the inactivity timer resets
  on every received chunk. `rejectAll(err)` rejects every in-flight request (for provider
  disconnects).
- **provider** — `ProviderService(send, callLlm, { onRequestLog?, maxLogEntries? })`. Keeps request
  logs (`started` / `streaming` / `done` / `error`, `charCount`, `detail`); `getLogs()` returns
  newest first. `rejectLlmRequest(send, toId, id)` sends the `unsupported_service` rejection.
- **voice-consumer** — `VoiceConsumerService(send, options?)`. `requestTts` / `requestStt` /
  `rejectAll` / `handleMessage`. Defaults: 120 s timeout, 24 M base64-char audio cap, 4000-char TTS
  text cap (all overridable via options).
- **voice-provider** — `VoiceProviderService(send, synthesize, transcribe, options?)`. In-order
  chunk reassembly, 16 concurrent STT streams max (overridable), `dropPeer(fromId)`.
- **openai** — `streamChatCompletion(config, messages, onDelta?, fetchFn?)` (SSE streaming with a
  non-streaming JSON fallback; `temperature` / `reasoningEffort` are only sent when set),
  `fetchModels(config, fetchFn?)`.
- **node** — `Network({ createNode, nodeId?, nodeIdStorageKey?, callbacks? })`. `join(roomId)` /
  `send(toId | null, msg)` (always `DELIVERY_RELIABLE`) / `leave()` / `destroy()`. Includes
  disposal-race guards (events from a replaced node are ignored; destroy during init leaves
  immediately).
- **client** —
  `ConsumerClient({ createNode, nodeIdStorageKey?, providerWaitTimeoutMs?, requestTimeoutMs? })`.
  `connect(roomId)` (eager, never throws) / `disconnect()` / `requestChat` / `requestTts` /
  `requestStt`, plus `status` + `onStatusChange` (`idle → joining → searching → connected/error`;
  `connected` carries `providerId` and `models?`). Sends `consumer_hello` after joining and upon
  receiving a `provider_hello`.
- **tunnel** — `OaiTunnelClient({ createNode, nodeIdStorageKey, requestTimeoutMs? })`
  (`request(roomId, { path, method?, contentType?, body? })` → `{ status, contentType, body }`,
  `disconnect()`) and `OaiTunnelProvider(send, resolveUpstream)` (`handleMessage(fromId, msg)`
  returns `true` when it consumed an `oai_*` message, `dropPeer(peerId)`). See
  [`protocol.md`](protocol.md).
- **shared-node** — `createSharedNodeScope(createRealNode)` → a `createNode` factory that
  multiplexes every handle it produces onto one real node. See [`protocol.md`](protocol.md).

## `@tik-choco/mistai/preact`

Requires the optional `preact` peer dependency.

### Hooks

- `useConsumerStatus(client)` — subscribes to `ConsumerStatus`.
- `useConsumerConnection(client, { enabled, roomId, debounceMs? })` — side-effect hook: debounced
  `connect` while enabled, `disconnect` when disabled.
- `useNetworkProvider({ enabled, roomId, createNode, callLlm?, synthesize?, transcribe?, advertisedModels?, advertisedVoices?, extraServices?, resolveOaiUpstream?, nodeIdStorageKey?, maxLogEntries? })`
  — manages the provider join/leave lifecycle and returns
  `{ status, statusUpdatedAt, errorMessage, peers, peerCount, consumerCount, logs, ownNodeId, roomId }`.

  Broadcasts `provider_hello` after joining and to each newly connected peer, with `services`
  derived from which of `callLlm` / `synthesize` / `transcribe` are injected, plus `extraServices`
  and — automatically — `'oai'` whenever `resolveOaiUpstream` is set. Peers that send
  `consumer_hello` are marked as consumers. Requests for a service that is not injected are
  rejected with `code: "unsupported_service"`.

  **Hello re-broadcast**: whenever the advertised set changes while already connected, a fresh
  `provider_hello` goes to every peer in place — no leave/rejoin, so in-flight requests survive a
  live share-list edit.

  **OAI tunnel**: passing `resolveOaiUpstream` wires an internal `OaiTunnelProvider` into the
  hook's own message routing (consulted before everything else) and drops its per-peer state on
  disconnect.

- `deriveHelloServices({ callLlm?, synthesize?, transcribe? })` and
  `routeProviderRequest(fromId, msg, deps)` are exported as pure helpers, so a non-preact host
  driving the wire protocol directly gets the same capability-mismatch behavior.

### Components

All take an optional `messages: MistaiMessages` (default `MESSAGES_EN`). Import the default styles
with `import '@tik-choco/mistai/ui.css'` and theme via `--mistai-*` CSS custom properties (border,
surface, text, text-muted, text-strong).

- `ConsumerStatusIndicator({ status, updatedAt?, variant?, note?, messages? })` — colored dot plus
  status label, with a click-to-open detail popover (step progression, provider id, localized
  error).
- `ConsumerStepIndicator({ status, messages? })` — standalone idle → joining → searching →
  connected step row.
- `ProviderStatusPanel({ status, statusUpdatedAt?, errorMessage?, ownNodeId?, peers, consumerCount, logs, notice?, logPageSize?, messages? })`
  — provider summary line, app-supplied `notice` slot, collapsible peer list and request log with
  paging.
- `consumerErrorText(status, messages)` — localized error string for an error-phase
  `ConsumerStatus` (catalog code first, raw message fallback).

### Settings screen

`LlmSettings` is a shared three-tab settings UI (AI Connection / AI Network / Tasks). Apps supply
task definitions plus small adapters (`LlmSettingsConnectionAdapter`, `LlmSettingsProviderAdapter`,
`LlmSettingsVoiceAdapter`) and get the family-common screens; the shared config itself is managed
internally through `llm-config`. Wording ships as `LLM_SETTINGS_MESSAGES_EN` /
`LLM_SETTINGS_MESSAGES_JA`, shaped by `LlmSettingsMessages`.

## `@tik-choco/mistai/llm-config`

The cross-app shared LLM configuration, stored in localStorage under `tc-shared-llm-config-v1`
(last-write-wins across apps on the same origin). Not re-exported from the package root.

- Types — `SharedLlmConfigV1`, `LlmProviderV1`, `ModelPresetV1`, `VoiceConfigV1`,
  `ResolvedLlmTargetV1`.
- Load/save — `emptyLlmConfig()`, `loadLlmConfig()`, `saveLlmConfig(config)`,
  `subscribeLlmConfig(cb)` (cross-tab `storage` event).
- Mutation — `createProvider` / `patchProvider` / `deleteProvider`, `createPreset` /
  `ensureProvider` / `ensurePreset`.
- Resolution — `resolvePreset(config, presetId?)` → `ResolvedLlmTargetV1 | null`,
  `resolveVoice(...)`, `normalizeBaseUrl(url)`.

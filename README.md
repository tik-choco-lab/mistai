# @tik-choco/mistai — shared LLM Network library

## Overview

This library consolidates the mistllm implementation that had been copied into
several apps (tc-mistllm / tc-translate / tc-pdf-viewer / tc-note): the wire
protocol, consumer/provider services, voice (TTS/STT), the OpenAI-compatible
upstream client, and preact hooks.

- The protocol is **wire compatible (v: 1)** with the existing implementations.
  Old and new clients can share the same room.
- mistlib (wasm) is **not bundled**. Each app injects its own vendored mistlib
  node via `createNode`. Wiring the services directly to a custom transport
  (e.g. a Yjs collab room) is also supported.
- The core has no preact dependency. Hooks live in the separate
  `@tik-choco/mistai/preact` subpath; preact is an optional peerDependency.

## Architecture

### Roles

- **Consumer**: joins a room and sends `llm_request` / `tts_request` /
  `stt_request` to the first provider that announces itself via
  `provider_hello`.
- **Provider**: joins a room, broadcasts `provider_hello`, forwards incoming
  requests to the injected upstream functions (`LlmCallFn` / `SynthesizeFn` /
  `TranscribeFn`), and streams the results back in chunks.

### Protocol v1 message reference

| type | direction | contents |
|---|---|---|
| `provider_hello` | provider → all/peer | provider announcement. Optional `models: string[]` (upstream model list; backward-compatible extension) |
| `consumer_hello` | consumer → all/provider | consumer announcement (lets providers classify peers) |
| `llm_request` | consumer → provider | `id`, `messages: ChatMessage[]`, optional `model` |
| `llm_response_chunk` | provider → consumer | `id`, `delta`, optional `seq` (0-based, monotonic; absent = legacy arrival order) |
| `llm_response_done` | provider → consumer | `id`, optional `content` (falls back to the consumer's accumulated deltas) |
| `llm_error` | provider → consumer | `id`, `message` |
| `raft_message` | consumer ⇔ consumer | opaque scheduler payload (base64 bincode); passed through untouched at this layer |
| `tts_request` | consumer → provider | `id`, `text` (≤ 4000 chars), optional `model` / `voice` |
| `tts_response` | provider → consumer | `id`, `seq`, `data` (base64 sub-chunk), `last`, `mime` |
| `stt_request` | consumer → provider | `id`, `seq`, `data`, `last`, `mime`; `model` / `fileName` ride on seq 0 |
| `stt_response` | provider → consumer | `id`, `text` |
| `voice_error` | provider → consumer | `id`, `message` (shared error for tts/stt) |

`decode()` trusts nothing: malformed messages return `null` (unknown fields are
stripped, `seq` must be an integer ≥ 0, `id` must be a non-empty string, and so
on). `provider_hello.models` is dropped as a field when it is not an array, and
non-string elements are filtered when it is — so the optional extension can
never break provider discovery itself.

### Transport injection

The library never imports mistlib. `Network` / `ConsumerClient` /
`useNetworkProvider` accept `createNode: (nodeId) => MistNodeLike`, and
anything satisfying `MistNodeLike` (`init` / `onEvent` / `joinRoom` /
`leaveRoom` / `sendMessage`) works. The mist event/delivery constants
(`EVENT_RAW=0`, `EVENT_PEER_CONNECTED=5`, `EVENT_PEER_DISCONNECTED=6`,
`DELIVERY_RELIABLE=0`) are re-declared and exported by the library.

At a lower level, `ConsumerService` / `ProviderService` /
`VoiceConsumerService` / `VoiceProviderService` take only a
`SendFn = (toId, msg) => void`, so they can be wired straight into a custom
transport that doesn't involve mist at all (see pattern B below).

### One MistNode per page

The mistlib wasm node assumes one node and one room per page. Running the
consumer and provider on the same page at the same time requires app-side room
arbitration (something like tc-pdf-viewer's claimRoom/releaseRoom).
`ConsumerClient` and `useNetworkProvider` each create their own `Network`
(= node), so concurrent use depends on the app's mistlib wrapper semantics.

## API reference (summary)

### `@tik-choco/mistai`

- **protocol** — `encode(msg)` / `decode(bytes|string)`, every message
  interface, the `ProtocolMessage` union, `ChatMessage`.
- **base64** — `blobToBase64` / `base64ToBlob` / `chunkBase64` /
  `VOICE_CHUNK_SIZE` (12 KB). `blobToBase64` does not use FileReader (works in
  Node too).
- **messages** — `MistaiMessages` catalogs `MESSAGES_EN` / `MESSAGES_JA`
  (canonical status labels + one message per error code) and
  `formatMistaiError(err, messages, fallback?)` /
  `formatMistaiCode(code, messages)`. See "Error handling and localization".
- **id** — `randomId()` (UUID that also works outside secure contexts),
  `getPersistentNodeId(storageKey = "mistai:node-id")` (falls back to memory
  when localStorage is unavailable; never throws).
- **consumer** — `ConsumerService(send)`.
  `request(providerId, messages, { model?, onDelta?, timeoutMs? })` handles seq
  reordering, duplicate dropping, and legacy no-seq senders. With `timeoutMs`
  set, the inactivity timer resets on every received chunk. `rejectAll(err)`
  rejects every in-flight request (for provider disconnects).
- **provider** — `ProviderService(send, callLlm, { onRequestLog?, maxLogEntries? })`.
  Keeps request logs (`started` / `streaming` / `done` / `error`, `charCount`,
  `detail`); `getLogs()` returns newest first.
- **voice-consumer** — `VoiceConsumerService(send, options?)`. `requestTts` /
  `requestStt` / `rejectAll` / `handleMessage`. Defaults: 120 s timeout, 24 M
  base64-char audio cap, 4000-char TTS text cap (all overridable via options).
- **voice-provider** — `VoiceProviderService(send, synthesize, transcribe, options?)`.
  In-order chunk reassembly, 16 concurrent STT streams max (overridable),
  `dropPeer(fromId)`.
- **openai** — `streamChatCompletion(config, messages, onDelta?, fetchFn?)`
  (SSE streaming with a non-streaming JSON fallback; `temperature` /
  `reasoningEffort` are only sent when set), `fetchModels(config, fetchFn?)`.
- **node** — `Network({ createNode, nodeId?, nodeIdStorageKey?, callbacks? })`.
  `join(roomId)` / `send(toId | null, msg)` (always `DELIVERY_RELIABLE`) /
  `leave()` / `destroy()`. Includes disposal-race guards (events from a
  replaced node are ignored; destroy during init leaves immediately).
- **client** — `ConsumerClient({ createNode, nodeIdStorageKey?, providerWaitTimeoutMs?, requestTimeoutMs? })`.
  `connect(roomId)` (eager, never throws) / `disconnect()` / `requestChat` /
  `requestTts` / `requestStt`, plus `status` + `onStatusChange`
  (`idle → joining → searching → connected/error`; `connected` carries
  `providerId` and `models?`). Sends `consumer_hello` after joining and upon
  receiving a `provider_hello`.

### `@tik-choco/mistai/preact`

- `useConsumerStatus(client)` — subscribes to `ConsumerStatus`.
- `useConsumerConnection(client, { enabled, roomId, debounceMs? })` —
  side-effect hook: debounced `connect` while enabled, `disconnect` when
  disabled.
- `useNetworkProvider({ enabled, roomId, createNode, callLlm?, synthesize?, transcribe?, advertisedModels?, ... })`
  — manages the provider join/leave lifecycle and returns
  `{ status, statusUpdatedAt, errorMessage, peers, peerCount, consumerCount, logs, ownNodeId, roomId }`.
  Broadcasts `provider_hello` (with `models` when `advertisedModels` is set)
  after joining and to each newly connected peer, and marks peers that send
  `consumer_hello` as consumers.

## Getting started

### Install

The package is not published to npm. Install it straight from GitHub — the
`prepare` script builds `dist/` automatically during install:

```json
{
  "dependencies": {
    "@tik-choco/mistai": "github:tik-choco-lab/mistai"
  }
}
```

To pin a specific version, append a tag or commit:
`github:tik-choco-lab/mistai#v0.1.0`.

Alternatively, when developing the library and an app side by side with
sibling checkouts, a local file reference avoids reinstalling on every change:

```json
{
  "dependencies": {
    "@tik-choco/mistai": "file:../mistai"
  }
}
```

With `file:`, run `npm install` once inside mistai first so the `prepare`
script builds `dist/`, then run `npm install` in the app.

### Pattern A: apps with a mistlib node (tc-translate / tc-pdf-viewer / tc-chat / tc-storage / tc-vrm-viewer)

Inject the vendored mistlib wrapper's `MistNode`.

Consumer side:

```ts
import { ConsumerClient } from '@tik-choco/mistai'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

export const llmClient = new ConsumerClient({
  createNode: (id) => new MistNode(id),
  nodeIdStorageKey: 'tc-translate-mistllm-node-id-v1', // to keep an app's existing key
})

// from the UI
const reply = await llmClient.requestChat(roomId, messages, { model, onDelta })
const audio = await llmClient.requestTts(roomId, { text, model, voice })
const text = await llmClient.requestStt(roomId, { audio: blob, model, fileName })
```

Provider side (preact):

```ts
import { streamChatCompletion } from '@tik-choco/mistai'
import { useNetworkProvider } from '@tik-choco/mistai/preact'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

const provider = useNetworkProvider({
  enabled: settings.networkProviderEnabled,
  roomId: settings.roomId,
  createNode: (id) => new MistNode(id),
  callLlm: (messages, model, onDelta) =>
    streamChatCompletion(
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: model ?? settings.model },
      messages,
      onDelta,
    ),
  synthesize: async (text, model, voice) => ({ blob: await ttsUpstream(text, model, voice), mime: 'audio/mpeg' }),
  transcribe: (audio, mime, model, fileName) => sttUpstream(audio, model, fileName),
  advertisedModels: models, // e.g. fetchModels() results, published as provider_hello.models
})
```

### Pattern B: apps with a custom transport (tc-note's Yjs collab room)

When mist is not involved, wire a `SendFn` directly:

```ts
import { ConsumerService, ProviderService, decode, encode } from '@tik-choco/mistai'

// sending: put messages on your own transport
const consumer = new ConsumerService((toId, msg) => room.sendTo(toId, encode(msg)))
const provider = new ProviderService((toId, msg) => room.sendTo(toId, encode(msg)), callLlm)

// receiving: decode bytes from the transport and dispatch
room.onMessage((fromId, bytes) => {
  const msg = decode(bytes)
  if (!msg) return
  consumer.handleMessage(msg)
  void provider.handleMessage(fromId, msg)
})
```

### Migration map from existing apps

**tc-translate `src/lib/mistllm/*` → mistai**

| old | new |
|---|---|
| `protocol.ts` | `@tik-choco/mistai` (`encode` / `decode` / types) |
| `base64.ts` | `@tik-choco/mistai` (`blobToBase64` etc.) |
| `randomId` in `node.ts` | `randomId` |
| `Network` in `node.ts` | `Network` (now takes an injected `createNode`) |
| `consumer.ts` | `ConsumerService` (`request` now takes an options object) |
| `provider.ts` | `ProviderService` (same API) |
| `voice-consumer.ts` / `voice-provider.ts` | `VoiceConsumerService` / `VoiceProviderService` |
| `client.ts` (module singleton) | a `ConsumerClient` instance (make it a singleton in the app) |
| `hooks/useNetworkConsumerStatus.ts` | `useConsumerStatus` in `@tik-choco/mistai/preact` |
| `hooks/useNetworkConsumerConnection.ts` | `useConsumerConnection` |
| `hooks/useNetworkProvider.ts` | `useNetworkProvider` (options no longer tied to app settings) |

**tc-note `src/lib/mistllm/*` → mistai**

| old | new |
|---|---|
| `protocol.ts` | `@tik-choco/mistai` |
| `consumer.ts` / `provider.ts` | `ConsumerService` / `ProviderService` (direct SendFn, pattern B) |

**tc-pdf-viewer `src/services/mistllm.js` → mistai**

| old | new |
|---|---|
| protocol part (incl. `provider_hello.models`) | `@tik-choco/mistai` |
| `NetworkChatClient` (timeouts, provider wait) | `ConsumerClient` (`providerWaitTimeoutMs` / `requestTimeoutMs`) |
| provider part | `ProviderService` + `useNetworkProvider` (`advertisedModels`) |
| claimRoom/releaseRoom single-node arbitration | stays in the app (out of scope for the library) |

### Notes

- **mistlib wasm is not bundled.** Inject each app's vendored mistlib via
  `createNode`.
- The localStorage node-id key defaults to `mistai:node-id`; pass an app's old
  key (e.g. `tc-translate-mistllm-node-id-v1`) as `nodeIdStorageKey` to keep an
  existing identity.
- The protocol is wire compatible (v: 1) with the existing implementations.
  Old clients/providers and this library can share a room
  (`provider_hello.models` and `seq` are optional extensions).
- `ConsumerClient.connect()` never throws. Receive errors via
  `onStatusChange` as `{ phase: 'error' }`.

## Error handling and localization

The library's default messages are English, but apps are expected to be
multilingual. Every failure the library generates locally is a `MistaiError`
with a stable `code` (`MistaiErrorCode`), so UIs should localize by mapping
the code rather than displaying or matching the English `message`.

For consistency across apps, the library ships canonical UI wording as
`MistaiMessages` catalogs (`MESSAGES_EN`, `MESSAGES_JA`): status labels for
the consumer lifecycle (full and step-indicator forms), provider status, the
provider request log, and one message per error code. Use these instead of
hand-rolling labels so terminology doesn't drift between apps:

```ts
import { MESSAGES_JA, formatMistaiError, formatMistaiCode } from '@tik-choco/mistai'

// Status labels
label = MESSAGES_JA.consumerPhase[status.phase]

// Error display (REMOTE_ERROR passes the remote-authored message through)
try {
  await llmClient.requestChat(roomId, messages)
} catch (err) {
  showToast(formatMistaiError(err, MESSAGES_JA, 'Request failed.'))
}

// ConsumerStatus error phase carries a code when one applies
message = formatMistaiCode(status.code, MESSAGES_JA) ?? status.message
```

Apps supporting other languages provide their own `MistaiMessages` object
with the same shape (the `errors` record is exhaustive over
`MistaiErrorCode`, so a missing translation is a type error).

- `MistaiError.details` carries interpolation values (e.g. `{ status: 401 }`
  for `UPSTREAM_HTTP_ERROR`).
- `ConsumerStatus`'s `{ phase: 'error' }` also includes the `code` when one
  applies (`PROVIDER_NOT_FOUND`, `JOIN_FAILED`).
- Errors relayed from a remote peer (`llm_error` / `voice_error`) have code
  `REMOTE_ERROR`; their `message` text is authored by the remote provider and
  arrives in whatever language that provider runs in — it cannot be localized
  on the consumer side.

## License

[MPL-2.0](./LICENSE)

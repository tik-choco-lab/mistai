# Protocol and transport

The wire format, the OpenAI tunnel, and how a transport gets injected.

## Roles

- **Consumer** joins a room, collects every `provider_hello` into a provider table, and picks a
  provider per request: filter by required service (`chat` / `tts` / `stt`; a hello without
  `services` counts as chat-only), prefer an exact `models` match when a model is requested
  (falling back to a provider that advertises no models, sent without a model), pick randomly
  among ties, and fail over once to the next candidate on disconnect, timeout, or an
  `unsupported_service` error.
- **Provider** joins a room, broadcasts `provider_hello` (with `services` derived from which
  upstream functions are injected), forwards incoming requests to the injected upstream functions
  (`LlmCallFn` / `SynthesizeFn` / `TranscribeFn`), streams the results back in chunks, and rejects
  requests for services it does not offer with an immediate `llm_error` / `voice_error` carrying
  `code: "unsupported_service"`.

## Message reference (v: 1)

| type | direction | contents |
|---|---|---|
| `provider_hello` | provider → all/peer | provider announcement. Optional `models: string[]`, `services: string[]`, `voices: string[]` — all backward-compatible extensions |
| `consumer_hello` | consumer → all/provider | consumer announcement (lets providers classify peers) |
| `llm_request` | consumer → provider | `id`, `messages: ChatMessage[]`, optional `model`, `reasoning_effort: string` |
| `llm_response_chunk` | provider → consumer | `id`, `delta`, optional `seq` (0-based, monotonic; absent = legacy arrival order) |
| `llm_response_done` | provider → consumer | `id`, optional `content` (falls back to the consumer's accumulated deltas) |
| `llm_error` | provider → consumer | `id`, `message` |
| `raft_message` | consumer ⇔ consumer | opaque scheduler payload (base64 bincode); passed through untouched at this layer |
| `tts_request` | consumer → provider | `id`, `text` (≤ 4000 chars), optional `model` / `voice` / `lang` / `speed` / `response_format` |
| `tts_response` | provider → consumer | `id`, `seq`, `data` (base64 sub-chunk), `last`, `mime` |
| `stt_request` | consumer → provider | `id`, `seq`, `data`, `last`, `mime`; `model` / `fileName` ride on seq 0 |
| `stt_response` | provider → consumer | `id`, `text` |
| `voice_error` | provider → consumer | `id`, `message` (shared error for tts/stt) |
| `oai_request` | consumer → provider | `id`, `seq`, `last`, `data` (base64 chunk); `path`/`method`/`contentType` ride on seq 0 |
| `oai_response` | provider → consumer | `id`, `seq`, `last`, `data`; `status`/`contentType` ride on seq 0 |
| `oai_error` | provider → consumer | `id`, `message`, optional `code` (`unsupported_path` / `request_rejected` / `request_too_large`) |

`decode()` trusts nothing: malformed messages return `null` (unknown fields are stripped, `seq`
must be an integer ≥ 0, `id` must be a non-empty string, and so on). `provider_hello.models` is
dropped as a field when it is not an array, and non-string elements are filtered when it is — so
the optional extension can never break provider discovery itself.

The protocol is wire compatible with the pre-library implementations this was extracted from, so
old and new clients can share a room.

`tts_request.speed` is an optional finite number in 0.25–4.0;
`response_format` is one of `mp3`, `opus`, `aac`, `flac`, `wav`, `pcm`.
Invalid values drop only that field. Providers forward valid hints upstream;
an omitted speed uses their configured default. If the requested container is
unsupported, providers may return another format and must report its actual
`tts_response.mime`. Consumers trust that MIME type, never the requested format.

`llm_request.reasoning_effort` is an additive v1 extension: `none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`, and unknown strings pass through unchanged.
Providers forward a present value upstream, overriding their own default;
absence uses the default for old consumers. Invalid non-string effort drops
only that optional field. Old providers ignore it; response streaming is unchanged.

Room chat -> `llm_request` (streaming). The oai tunnel is only for vision/OCR
image content parts, `/models`, and `/embeddings`; task effort uses `llm_request`.

## OAI tunnel — OpenAI-compatible HTTP over P2P

`OaiTunnelClient` / `OaiTunnelProvider` proxy an arbitrary OpenAI-compatible HTTP endpoint
(`/chat/completions`, `/models`, `/embeddings`, …) through a room, on top of the native `oai_*`
messages above — no separate codec needed, `Network`'s own `decode()` already understands them.

Why it exists: it lets a consumer use *any* upstream feature (e.g. vision/image inputs) that the
request/response-shaped `llm_request` protocol doesn't model, by tunneling the raw HTTP call
instead of adding feature-specific wire messages for each one.

- Bodies travel as 12 KB base64 chunks (a ~16 KB per-message safety margin), reassembled up to a
  24 MB cap; requests time out after 120 s by default. A provider announces tunnel support by
  adding `'oai'` (`OAI_TUNNEL_SERVICE`) to `provider_hello.services`.
- **The consumer's credentials never touch the wire.** `oai_request` has no auth field by design —
  the provider always forwards to its own upstream with its own `OaiUpstream.apiKey`; a consumer
  can only reach whatever upstream(s) the provider's `OaiUpstreamResolver` chooses to expose.
- The resolver is the provider's policy boundary: return `null` to refuse a path outright
  (`unsupported_path`), or throw to refuse for a request-specific reason, e.g. an unshared model
  (`request_rejected`) — the thrown message is relayed to the consumer as-is.
- v1 has no streaming: the provider must resolve to a non-streaming upstream call (e.g. via
  `OaiUpstream.rewriteBody` forcing `stream: false`) and relay the full response in one shot.
  `/audio/*` is intentionally out of scope — that's what `tts_request` / `stt_request` are for.

```ts
import { OaiTunnelClient } from '@tik-choco/mistai'

const tunnel = new OaiTunnelClient({ createNode, nodeIdStorageKey: 'my-app:node-id' })
const res = await tunnel.request(roomId, { path: '/chat/completions', body: JSON.stringify(payload) })
```

On the provider side, pass `resolveOaiUpstream` to `useNetworkProvider` rather than constructing
`OaiTunnelProvider` directly.

## Transport injection

The library never imports mistlib. `Network` / `ConsumerClient` / `useNetworkProvider` accept
`createNode: (nodeId) => MistNodeLike`, and anything satisfying `MistNodeLike` (`init` / `onEvent`
/ `joinRoom` / `leaveRoom` / `sendMessage`) works. The event/delivery constants (`EVENT_RAW=0`,
`EVENT_PEER_CONNECTED=5`, `EVENT_PEER_DISCONNECTED=6`, `DELIVERY_RELIABLE=0`) are re-declared and
exported by the library.

At a lower level, `ConsumerService` / `ProviderService` / `VoiceConsumerService` /
`VoiceProviderService` take only a `SendFn = (toId, msg) => void`, so they can be wired straight
into a transport that doesn't involve a mesh node at all.

## One node per page

The mistlib wasm node assumes one node and one room per page. Running a consumer and a provider on
the same page at the same time requires app-side room arbitration, **or**
`createSharedNodeScope(createRealNode)`, which multiplexes any number of `Network`-owning stacks
onto one real node without arbitration.

A shared scope hands out lightweight handles: events fan out to every handle (filtered by the
rooms *that handle* joined), and room departure is reference-counted so one stack disconnecting
doesn't evict a room-mate. The one real consequence: every handle sharing a scope is one peer on
the wire, so a page's own provider can't be discovered by that same page's consumer if they share
a scope (broadcasts are not looped back to the sender) — a degenerate case with no practical loss.

```ts
import { createSharedNodeScope } from '@tik-choco/mistai'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

// Once per page, reused as `createNode` by every stack that should share an identity:
export const createSharedMistNode = createSharedNodeScope((nodeId) => new MistNode(nodeId))
```

Apps with only one network stack alive at a time don't need this — pass the raw
`(id) => new MistNode(id)` factory directly.

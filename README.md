<div align="center">

# mistai

**A shared LLM network over peer-to-peer rooms — one browser lends its model, the others use it.**

[![version](https://img.shields.io/github/v/tag/tik-choco-lab/mistai?label=version&color=2f6feb)](https://github.com/tik-choco-lab/mistai/tags)
[![license](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

English · [日本語](README.ja.md) · [简体中文](README.zh.md)

</div>

---

One peer in a room holds an API key and a model endpoint. Everyone else in that room can talk to
it — chat, text-to-speech, speech-to-text — without ever seeing the key, because requests are
forwarded by the peer that owns it rather than shared out. Providers announce which services and
models they offer; consumers pick a match, and fail over when one goes quiet.

Written in TypeScript, for the browser. The transport is not bundled: you inject a
[mistlib](https://github.com/tik-choco-lab/mistlib) wasm node, or anything else that can send
bytes to a peer.

## Features

|  |  |
| --- | --- |
| **Bring your own transport** | Inject a mistlib node, a collaboration room, anything with send/receive — no mesh library is bundled |
| **Chat, TTS and STT** | One protocol for all three, with chunked streaming and reordering |
| **Capability matching** | Providers advertise services, models and voices; consumers filter, pick, and fail over once |
| **OpenAI tunnel** | Proxy any OpenAI-compatible endpoint over the room, so features the chat protocol doesn't model still work |
| **Keys stay home** | The consumer's request carries no credentials; the provider forwards it upstream with its own |
| **Optional preact UI** | Status indicators, a provider panel, and a shared three-tab settings screen |
| **Portable identity** | DID delegation chains recognize the same person across origins and devices |

## Install

Not on npm. Install from GitHub — the `prepare` script builds `dist/` during install:

```json
{
  "dependencies": {
    "@tik-choco/mistai": "github:tik-choco-lab/mistai#v0.8.0"
  }
}
```

Drop the `#v0.8.0` to track the default branch. For side-by-side development with sibling
checkouts, `"file:../mistai"` avoids reinstalling on every change — run `npm install` inside mistai
once first, so `prepare` builds `dist/`.

`preact` is an optional peer dependency, needed only for the `/preact` subpath.

## Usage

### With a mesh node

Inject the vendored mistlib wrapper's `MistNode`. Consumer side:

```ts
import { ConsumerClient } from '@tik-choco/mistai'
import { MistNode } from '../vendor/mistlib/wrappers/web/index.js'

export const llmClient = new ConsumerClient({
  createNode: (id) => new MistNode(id),
  nodeIdStorageKey: 'my-app:node-id', // optional: reuse a key the app already persists
})

const reply = await llmClient.requestChat(roomId, messages, { model, onDelta })
const audio = await llmClient.requestTts(roomId, { text, model, voice })
const text  = await llmClient.requestStt(roomId, { audio: blob, model, fileName })
```

Provider side, with preact:

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
  advertisedModels: models, // published as provider_hello.models
})
```

Which services get advertised follows from which upstream functions you pass. Omit `synthesize`
and TTS requests are rejected with `unsupported_service` rather than timing out.

### With any other transport

The services underneath take a plain send function, so no mesh node is involved:

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

## API

| Import | Contents |
| --- | --- |
| `@tik-choco/mistai` | Protocol, consumer/provider services, voice, OpenAI client, tunnel, node facade |
| `@tik-choco/mistai/preact` | Hooks, status and log components, the shared settings screen |
| `@tik-choco/mistai/llm-config` | The cross-app shared LLM configuration in localStorage |
| `@tik-choco/mistai/identity` | DID delegation chains |

Full listing in [`docs/api.md`](docs/api.md).

## Localization

Default messages are English, but every failure the library raises locally is a `MistaiError` with
a stable `code`. Localize by mapping the code — never by matching the English text.

```ts
import { MESSAGES_JA, formatMistaiError, formatMistaiCode } from '@tik-choco/mistai'

label = MESSAGES_JA.consumerPhase[status.phase]

try {
  await llmClient.requestChat(roomId, messages)
} catch (err) {
  showToast(formatMistaiError(err, MESSAGES_JA, 'Request failed.'))
}
```

`MESSAGES_EN` and `MESSAGES_JA` ship canonical wording for the consumer lifecycle, provider status
and request log, plus one message per error code. For another language, supply your own
`MistaiMessages` — the `errors` record is exhaustive over `MistaiErrorCode`, so a missing
translation is a type error.

One thing that cannot be localized: errors relayed from a remote peer carry code `REMOTE_ERROR`,
and their text was authored by that provider in whatever language it runs in.

## Protocol

Fifteen message types over a `v: 1` wire format, wire compatible with the implementations this
library was extracted from — old and new clients share a room. `decode()` trusts nothing and
returns `null` for anything malformed.

- [`docs/protocol.md`](docs/protocol.md) — message reference, the OpenAI tunnel, transport
  injection, and running several stacks on one node
- [`docs/identity.md`](docs/identity.md) — DID delegation chains

## Status

In use by several browser apps in the same family, but the API is not frozen — minor versions still
change it. Not published to npm; install from a git tag. The OpenAI tunnel does not stream in v1:
the provider resolves a non-streaming upstream call and relays the response in one shot.

## License

[Mozilla Public License 2.0](LICENSE)

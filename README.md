# mistai 0.10.3

A TypeScript library for shared HTTP model connections and peer-to-peer AI rooms.
Chat, TTS, STT and an OpenAI HTTP tunnel share one injected transport. Optional
Preact settings give apps the same Connections / Tasks / Sharing interface.

0.10.0 adds optional TTS speed/format hints and a Tasks-tab TTS speed control.
0.10.1 renders the TTS speed as the same choice picker as the other task rows (presets plus "provider default", which clears the stored speed).
0.10.2 exports `Switch` (`@tik-choco/mistai/preact`), the single on/off control for settings screens; its `.mistai-switch` styles in `ui.css` also work outside `.mistai-surface`. Use a checkbox only for picking items from a set.
0.10.3 keeps the model name visible in narrow pickers (the source label shrinks first) and labels "provider default" in ja/zh without English.
See the [0.9 migration notes](#migration-from-09-to-010) for provider callbacks.
The 0.9.0 **breaking 0.x release** replaced presets with `{ providerId, model }`
references. Rooms are providers, and temperature is never sent upstream. See the
[0.8 migration instructions](#migration-from-08) before updating an existing app.

## Install

Install from GitHub or a sibling checkout; `prepare` builds the distribution:

```json
{
  "dependencies": {
    "@tik-choco/mistai": "github:tik-choco-lab/mistai#v0.10.0"
  }
}
```

The release tag becomes usable when the maintainer publishes it. During rollout,
use `"file:../mistai"`. Preact is an optional peer dependency used by `/preact`.

## Shared connections and references

```ts
import {
  emptyLlmConfig, loadLlmConfig, saveLlmConfig,
  createProvider, patchProvider, createRoomProvider, setDefaultModel,
  resolveModel, migrateSharedLlmConfig,
} from '@tik-choco/mistai/llm-config'
import { refreshProviderModels, streamChatCompletion } from '@tik-choco/mistai'

const config = loadLlmConfig() ?? emptyLlmConfig()
if (migrateSharedLlmConfig(config).changed) saveLlmConfig(config)

const id = createProvider(config, 'My endpoint')
patchProvider(config, id, { baseUrl: 'https://example.test/v1', apiKey: '' })
createRoomProvider(config, { roomId: 'my-team-room', label: 'Team' })
setDefaultModel(config, { providerId: id, model: 'chosen-model-id' })
saveLlmConfig(config)
await refreshProviderModels(id, { force: true })

const target = resolveModel(config, taskRef)
if (!target) throw new Error('No usable model configured')
const answer = await streamChatCompletion(
  { ...target, reasoningEffort: 'none' }, messages, onDelta,
)
```

Config stays at `v: 1`, in `tc-shared-llm-config-v1` localStorage. Disabling or
deleting a provider preserves task/default/voice references. `resolveModel`
tries the exact reference, then only a usable `defaultModel`, then returns null.
`resolveModelExact` never falls back. Neither function changes stored references.

`models` and `modelsFetchedAt` hold discovery caches. Opening settings, sharing
or a picker revalidates enabled providers without a refresh button. The catalog
deduplicates simultaneous calls, throttles successful fetches for 10 seconds,
keeps cached models on failure, and discards results from superseded connections.
Connection edits and re-enabling use `{ force: true }`. No periodic polling runs.

## One node, multiple rooms

```ts
import {
  createSharedNodeScope, createRoomConsumers,
  requestRoomChat, requestRoomTts, requestRoomStt, requestRoomOpenAi,
} from '@tik-choco/mistai'
import { networkVoiceModelParam } from '@tik-choco/mistai/llm-config'
import { MistNode } from './vendor/mistlib/wrappers/web/index.js'

const nodeScope = createSharedNodeScope(id => new MistNode(id, signalingConfig))
export const rooms = createRoomConsumers(nodeScope, {
  nodeIdStorageKey: 'my-app:node-id',
})

await Promise.all([
  rooms.roomConsumer('team').connect('team'),
  rooms.roomConsumer('home').connect('home'),
])
const answer = await requestRoomChat('team', messages, {
  model: 'raw-model-id', reasoningEffort: task.reasoningEffort, onDelta,
})
const audio = await requestRoomTts('home', {
  text: 'Hello', model: networkVoiceModelParam('network-auto'),
})
const text = await requestRoomStt('home', { audio: recording })
const response = await requestRoomOpenAi('team', {
  path: '/embeddings', method: 'POST', contentType: 'application/json',
  body: JSON.stringify({ model: 'raw-model-id', input: 'Hello' }),
})
rooms.disconnectRoom('home') // team and its provider memberships survive
```

Call `createRoomConsumers` once at app startup. Its returned methods are scoped;
the top-level room helpers use the latest registered scope. The injected node
must support per-room sends (optional fourth `sendMessage` argument) and
per-room leaves. `joinRoomAsync`, when present, gates early announcements.
Only one real node is initialized, and room memberships are reference counted.

Apps should use one helper for streaming room chat:
`requestRoomChat(roomId: string, messages: ChatMessage[], options?: RoomChatOptions): Promise<string>`.
`RoomChatOptions` contains optional `model`, `reasoningEffort: string` and
`onDelta: (delta: string, full: string) => void`. The callback receives each
fragment and the accumulated reply; the promise resolves with the full text.
The scoped `rooms.requestRoomChat` uses the same API. Existing positional
`requestRoomChat(roomId, messages, model?, onDelta?)` calls remain supported.

**Routing rule: room chat -> `llm_request` (streaming); the oai tunnel is only
for vision/OCR image content parts, `/models`, and `/embeddings`.** Effort does
not require the tunnel. `ConsumerClient.requestChat` also accepts
`{ model?, reasoningEffort?, onDelta? }`.

The task's effort is sent as optional `llm_request.reasoning_effort` on wire v1.
Values `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and unknown
strings pass through unchanged. A present value overrides the provider default;
absence keeps the default (`RoomProviderService`'s `reasoningEffort`). Old
consumers still use that default, and old providers ignore the new field and
stream normally, without applying the task's effort. For low-level providers,
`ProviderService` passes effort as the optional fourth `LlmCallFn` argument;
set `options.reasoningEffort` for a default or keep the default in your callback.
Existing three-argument callbacks remain compatible.

## Preact settings and providing

```tsx
import { useState } from 'preact/hooks'
import {
  LlmSettings, useLlmConfig, useRoomProviders,
  type LlmLocalSettings,
} from '@tik-choco/mistai/preact'
import '@tik-choco/mistai/ui.css'
import { rooms } from './rooms'

function Settings({ open, onClose }) {
  const { config } = useLlmConfig()
  const [local, setLocal] = useState<LlmLocalSettings>(() => ({
    tasks: { summarize: { reasoningEffort: 'medium' } },
    roomProvide: {}, recentModels: [],
  }))
  useRoomProviders({
    config, roomProvide: local.roomProvide, consumers: rooms,
    taskRefs: Object.values(local.tasks).map(task => task.ref),
    settingsOpen: open,
  })
  return open ? <LlmSettings
    tasks={[{ id: 'summarize', label: 'Summarize', reasoning: true }]}
    localSettings={{ get: () => local, set: setLocal }}
    voice={{ tts: {}, stt: {} }}
    locale="ja"
    onClose={onClose}
  /> : null
}
```

Keep `useRoomProviders` mounted in the app shell, including when settings close.
It runs a provider in every enabled room whose local `roomProvide[id].enabled`
is true, and keeps consumers joined to rooms used by tasks, default or voice
settings, or sharing. `settingsOpen` discovers other enabled rooms on demand.
Removing, disabling or editing a room releases its old membership.

The local adapter implements `get()` / `set(next)` and optionally `subscribe(cb)`.
Persist these settings in the app's own storage; they are intentionally separate
from the family-wide connection config. A task without `ref` follows the default.
Reasoning values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`;
`none` is an explicit API value. Recents are deduplicated and capped at eight.

`voice.tts` and `voice.stt` enable their rows; their optional `get`/`set` adapters
override shared voice storage. `voice.tts.voiceOptions` supplies an HTTP voice-list
fallback. Room voice choices use live advertisements, and `network-auto` asks
that room's provider to choose its configured model. `mic` accepts `deviceId`,
`onChange`, optional `devices`, `labelsHidden` and `onUnlockLabels`; the host owns
device enumeration and permission requests.

`headerSection` inserts app controls above the tabs. `extraSections` accepts
content or a `(tab) => content` function below the current panel. Without
`onClose`, the component is an inline settings panel. With it, the dialog is
anchored at the top and guards backdrop dismissal by where a press began.
Optional `config` / `onConfigChange` provide controlled shared config. If used,
the host must persist changes with `saveLlmConfig` so catalog discovery sees them.

Built-in `locale` values: `en`, `ja`, `zh-CN`, `zh-TW`. `messages` overrides
individual keys from `LLM_SETTINGS_MESSAGES`. Task labels/tips are host supplied.
`npm test` and `npm run check:i18n` verify complete nonempty catalogs, no orphan
keys, and matching placeholders. Theme with `--mistai-surface`,
`--mistai-surface-2`, `--mistai-border`, `--mistai-border-strong`, `--mistai-text`,
`--mistai-text-muted`, `--mistai-text-strong`, `--mistai-primary`,
`--mistai-primary-soft`, `--mistai-focus`, `--mistai-focus-ring`,
`--mistai-danger-text` and `--mistai-font-family` on a parent. Portals inherit
the settings theme. Motion uses 120ms / 200ms and honors reduced-motion.

Each room advertises only raw model IDs from its enabled HTTP shared references.
Room models cannot be re-shared. Duplicate IDs resolve to the first usable ref
in list order. Named requests absent from a nonempty stored share list receive
`model_not_shared`; an empty model uses the enabled HTTP default, otherwise the
first usable shared ref. The OpenAI tunnel enforces the same model rules for
`/chat/completions`, `/models` and `/embeddings`, removes temperature, and buffers
chat responses. TTS/STT are advertised only with usable HTTP voice targets.

For a non-Preact host, `new RoomProviderService({ config, roomProvide, consumers })`
offers `update(options)`, `subscribe(cb)`, `states` and `destroy()`.

## Migration from 0.9 to 0.10

`SynthesizeFn` gains one optional trailing options object:
`(text, model, voice, lang, options?: { speed?: number; responseFormat?: string })`.
Existing four-argument providers still compile. Update your implementation to
forward `options.speed` and `options.responseFormat` to the upstream speech API
when present, and return the actual audio MIME type even if the requested format
cannot be honored. Consumers always trust the response MIME type.

`requestRoomTts`, `ConsumerClient.requestTts`, and `VoiceConsumerService.requestTts`
accept `speed` (finite, 0.25–4) and `responseFormat` (`mp3`, `opus`, `aac`, `flac`,
`wav`, `pcm`). Invalid hints are ignored independently. `requestRoomTts` uses the
current shared `tts.speed` when the caller omits speed;
an explicit caller speed wins. Only explicitly requested formats go on the wire.
The Tasks tab exposes shared TTS speed, including through voice adapters.
Wire and shared configuration versions remain v1.

## Migration from 0.8

1. Replace `ModelPresetV1` task IDs with `ModelRefV1`. Run
   `migrateSharedLlmConfig(config)` after loading and save **only if changed**.
   This creates `defaultModel`, imports `network.roomId` as a room provider and
   seeds manual HTTP preset IDs into caches. It is idempotent and leaves live
   fetched caches alone. `useLlmConfig` performs this shared migration for you.
2. Migrate app-local task refs with `presetIdToRef(config, oldId)`. Preserve each
   task's effort, otherwise inherit its old preset's `reasoningEffort`. Retired
   room mirror presets return undefined. Do this local migration once.
3. Convert local shared-preset IDs into refs under
   `roomProvide[roomProviderId].shared`; exclude room refs. Move the old local
   `networkProviderEnabled` flag into that room's `enabled` flag. Keep recents
   local. The key is the room **provider ID**, not the raw room ID.
4. Replace `LlmConnectionPanel`, `LlmNetworkPanel`, `LlmTasksPanel`, old
   preset adapters and preset CRUD/resolution/mirror helpers with `LlmSettings`
   and the adapters above. Stop using mirror-sync code. Remove temperature.
5. Initialize one shared node scope and `createRoomConsumers`. Replace the
   single-room app singleton with the room helpers. Use `useRoomProviders` for
   every providing room rather than one global provider switch.

```ts
const previous = config.presets.find(p => p.id === oldTask.presetId)
const task = {
  ref: presetIdToRef(config, oldTask.presetId),
  reasoningEffort: oldTask.reasoningEffort ?? previous?.reasoningEffort ?? 'none',
}
```

`presets`, `defaultPresetId` and `network` remain readable migration data and
are written back unchanged by `saveLlmConfig`; unmigrated same-origin apps still
need them. New code never changes them or silently rewrites dangling refs.
The localStorage key and wire protocol remain v1; the library version is 0.10.3.

## API and verification

See the [API overview](docs/api.md) and the [complete exported API](docs/exports.md).
Core protocol, low-level services, status components, generic provider hooks,
OpenAI client and `/identity` remain available.

```sh
npm test
npm run build
npm run check:i18n
npm run api:list
```

The transport is injected; unit tests use in-memory nodes. Real peer discovery
and upstream availability depend on the host's transport and endpoints.

Licensed under [MPL-2.0](LICENSE).

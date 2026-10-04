# API reference (0.9.0)

The [complete exported value/type list](exports.md) is generated from the public
TypeScript entry points. See [README](../README.md) for usage and 0.8 migration.

| Import | Contents |
| --- | --- |
| `@tik-choco/mistai` | Protocol, services, HTTP client, model catalog, room consumers/provider, shared node |
| `@tik-choco/mistai/preact` | Settings, pickers, room/config/catalog hooks, status and log components |
| `@tik-choco/mistai/llm-config` | Shared v1 localStorage configuration, resolution, CRUD and migration |
| `@tik-choco/mistai/identity` | DID keys, delegation chains, storage and pairing |
| `@tik-choco/mistai/ui.css` | Settings and status styles, theme/motion tokens |

## Core

Existing protocol (`encode` / `decode`), consumer/provider services,
`ConsumerClient`, `Network`, voice services, OpenAI client and tunnel remain
available. `streamChatCompletion(config, messages, onDelta?, fetchFn?)` sends
`reasoning_effort` when configured, including explicit `none`; it never sends
temperature. `fetchModels` and `fetchVoices` discover HTTP catalogs.

New model catalog:

- `refreshProviderModels(configOrId, { force? })`: accepts a provider, provider ID
  or shared config. Reads/persists against shared storage; callers save connection
  changes before fetching. One request per provider, successful-fetch throttle
  of 10 seconds, disabled-provider exclusion and superseded-connection guards.
- `revalidateProviderModels()`, `modelFetchStatus(idOrProvider)`,
  `subscribeModelFetchStatus(cb)`, `cacheRoomModels(roomId, models)`.

New room consumers:

- `createRoomConsumers(nodeScope, options?)`: returns scoped helpers and registers
  the default scope for the top-level helpers. Use the same factory from
  `createSharedNodeScope` for all stacks.
- `roomConsumer(roomId)`, `disconnectRoom(roomId)`.
- `requestRoomChat(roomId, messages, model?, onDelta?)`.
- `requestRoomTts(roomId, { text, model?, voice?, lang? })`.
- `requestRoomStt(roomId, { audio, model?, fileName? })`.
- `requestRoomOpenAi(roomId, { path, method?, contentType?, body? })`.

New provider:

- `RoomProviderService({ config, roomProvide, consumers?, reasoningEffort?,
  maxLogEntries? })`: `update(options)`, `subscribe(cb)`, `states`, `destroy()`.
- `resolveSharedTargets(config, refs)`: enabled HTTP refs only.
- `inboundTarget(config, shared, model?)`: raw-ID matching in list order; rejects
  named requests outside a nonempty shared list with `model_not_shared`. Empty
  model uses an enabled HTTP default, else first usable shared ref.
- `roomOaiUpstream(config, shared)`: `/chat/completions`, `/models`, `/embeddings`
  allowlist, same model rules, temperature removal and nonstreaming chat rewrite.

## Shared configuration

Types: `LlmProviderV1`, `ModelRefV1`, `SharedLlmConfigV1`, `VoiceConfigV1`,
`ResolvedLlmTargetV1`. Providers add optional `enabled`, `models`,
`modelsFetchedAt`; config adds optional `defaultModel`. Legacy presets/default
preset/network data remain available for migration and survive saves unchanged.

- Storage: `LLM_CONFIG_KEY`, `LLM_CONFIG_VERSION`, `emptyLlmConfig`,
  `loadLlmConfig`, `saveLlmConfig`, `subscribeLlmConfig` (same-tab and cross-tab).
- CRUD: `createProvider`, `createRoomProvider(config, { roomId, label? })` returning
  `{ id, existed }`, `patchProvider`, `deleteProvider`, `setDefaultModel`,
  `setVoiceConfig` (preserves independently configured speed).
- Resolution: `isModelRef`, `resolveModel`, `resolveModelExact`, `resolveVoice`.
- Room conventions: `providerKind`, `isNetworkProviderBaseUrl`,
  `networkProviderBaseUrl`, `roomIdFromBaseUrl`, `NETWORK_VOICE_AUTO_MODEL`,
  `networkVoiceModelParam`, `NETWORK_PROVIDER_URL_PREFIX`, `normalizeBaseUrl`.
- Migration: `migrateSharedLlmConfig(config)` returning `{ changed }`,
  `presetIdToRef(config, presetId)`. Neither persists automatically.

Preset CRUD/resolution and mirror-sync helpers are removed.

## Preact

`LlmSettings` has Connections / Tasks / Sharing tabs and accepts app-defined
`tasks`, a `localSettings` get/set/subscribe adapter, optional `voice` and `mic`
adapters, `locale`, message overrides, `headerSection`, `extraSections`,
`onClose`, `initialTab`, `title`, `className`, and optional controlled
`config`/`onConfigChange`. Adapter types are listed in [exports.md](exports.md).

`LLM_SETTINGS_MESSAGES` has en/ja/zh-CN/zh-TW catalogs. Theme through
`--mistai-*` CSS variables; portal surfaces retain the parent theme.

- `useLlmConfig()` returns `{ config, save(mutate) }`, migrates shared storage
  once and subscribes to changes.
- `useModelCatalog()` returns providers and catalog functions, subscribed to
  cache/status changes. Lists decide when to revalidate; the hook does not poll.
- `useRoomProviders(options)` reconciles all providing rooms and the consumer
  join policy. Supply `taskRefs` and `settingsOpen` along with provider options.
- Pickers: `ModelPicker`, `TwoPaneModelPicker`, `ReasoningPicker`, `ChoicePicker`.
- Matching/voice helpers: `matchesModelQuery`, `sameModel`, `modelKey`,
  `shouldShowTtsVoiceRow`, `resolveTtsVoiceOptions`, `buildTtsVoiceOptionValues`.

Existing `useConsumerStatus`, `useConsumerConnection`, generic
`useNetworkProvider`, capability-routing helpers and status/log components
remain available. Preset-era settings panels/adapters are removed.

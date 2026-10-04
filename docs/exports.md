# Exported API (v0.9.1)

Generated from the public entry points. `ui.css` is the stylesheet subpath.

## `@tik-choco/mistai`

**Values**

`base64ToBlob`, `base64ToBytes`, `base64ToUtf8`, `blobToBase64`, `bytesToBase64`, `cacheRoomModels`, `chunkBase64`, `ConsumerClient`, `ConsumerService`, `createRoomConsumers`, `createSharedNodeScope`, `decode`, `DEFAULT_MAX_LOG_ENTRIES`, `DEFAULT_NODE_ID_STORAGE_KEY`, `DEFAULT_PROVIDER_SERVICES`, `DELIVERY_RELIABLE`, `disconnectRoom`, `encode`, `ERROR_CODE_UNSUPPORTED_SERVICE`, `EVENT_PEER_CONNECTED`, `EVENT_PEER_DISCONNECTED`, `EVENT_RAW`, `fetchModels`, `fetchVoices`, `formatMistaiCode`, `formatMistaiError`, `getPersistentNodeId`, `getRoomConsumers`, `helloServices`, `inboundTarget`, `isFailoverEligible`, `MAX_AUDIO_BASE64_CHARS`, `MAX_CONCURRENT_STT_STREAMS`, `MAX_OAI_BASE64_CHARS`, `MAX_TTS_TEXT_CHARS`, `MESSAGES_EN`, `MESSAGES_JA`, `MistaiError`, `modelFetchStatus`, `Network`, `OAI_CHUNK_SIZE`, `OAI_PROVIDER_WAIT_TIMEOUT_MS`, `OAI_REQUEST_TIMEOUT_MS`, `OAI_TUNNEL_SERVICE`, `OaiTunnelClient`, `OaiTunnelProvider`, `OPENAI_TTS_VOICES`, `ProviderService`, `randomId`, `refreshProviderModels`, `rejectLlmRequest`, `rejectVoiceRequest`, `REQUEST_TIMEOUT_MS`, `requestRoomChat`, `requestRoomOpenAi`, `requestRoomStt`, `requestRoomTts`, `resolveSharedTargets`, `revalidateProviderModels`, `roomConsumer`, `roomOaiUpstream`, `RoomProviderService`, `selectProvider`, `streamChatCompletion`, `subscribeModelFetchStatus`, `utf8ToBase64`, `VOICE_CHUNK_SIZE`, `VoiceConsumerService`, `VoiceProviderService`.

**Types**

`ChatMessage`, `ConsumerClientOptions`, `ConsumerHelloMsg`, `ConsumerRequestOptions`, `ConsumerStatus`, `ConsumerStatusListener`, `FetchFn`, `KnownService`, `LlmCallFn`, `LlmErrorMsg`, `LlmRequestMsg`, `LlmResponseChunkMsg`, `LlmResponseDoneMsg`, `MistaiErrorCode`, `MistaiMessages`, `MistNodeLike`, `ModelFetchStatus`, `NetworkCallbacks`, `NetworkOptions`, `NodeScope`, `OaiErrorMsg`, `OaiRequestMsg`, `OaiResponseMsg`, `OaiTunnelClientOptions`, `OaiTunnelRequestInit`, `OaiTunnelResponse`, `OaiUpstream`, `OaiUpstreamResolver`, `OpenAIConfig`, `PendingRequest`, `ProtocolMessage`, `ProviderHelloMsg`, `ProviderLogEntry`, `ProviderLogOptions`, `ProviderLogStatus`, `ProviderSelection`, `RaftMessageMsg`, `RoomChatOptions`, `RoomConsumers`, `RoomProviderOptions`, `RoomProviderState`, `RoomProvideV1`, `SendFn`, `SttRequestMsg`, `SttResponseMsg`, `SynthesizeFn`, `TranscribeFn`, `TtsRequestMsg`, `TtsResponseMsg`, `VoiceConsumerOptions`, `VoiceErrorMsg`, `VoiceProviderOptions`, `VoiceServiceKind`.


## `@tik-choco/mistai/llm-config`

**Values**

`createProvider`, `createRoomProvider`, `deleteProvider`, `emptyLlmConfig`, `isModelRef`, `isNetworkProviderBaseUrl`, `LLM_CONFIG_KEY`, `LLM_CONFIG_VERSION`, `loadLlmConfig`, `migrateSharedLlmConfig`, `NETWORK_PROVIDER_URL_PREFIX`, `NETWORK_VOICE_AUTO_MODEL`, `networkProviderBaseUrl`, `networkVoiceModelParam`, `normalizeBaseUrl`, `patchProvider`, `presetIdToRef`, `providerKind`, `resolveModel`, `resolveModelExact`, `resolveVoice`, `roomIdFromBaseUrl`, `saveLlmConfig`, `setDefaultModel`, `setVoiceConfig`, `subscribeLlmConfig`.

**Types**

`LlmProviderV1`, `ModelRef`, `ModelRefV1`, `ResolvedLlmTargetV1`, `SharedLlmConfigV1`, `VoiceConfigV1`.


## `@tik-choco/mistai/preact`

**Values**

`buildTtsVoiceOptionValues`, `ChoicePicker`, `consumerErrorText`, `ConsumerStatusIndicator`, `ConsumerStepIndicator`, `deriveHelloServices`, `LLM_SETTINGS_MESSAGES`, `LlmSettings`, `matchesModelQuery`, `modelKey`, `ModelPicker`, `ProviderStatusPanel`, `REASONING_EFFORT_OPTIONS`, `reasoningEffortOptions`, `ReasoningPicker`, `resolveTtsVoiceOptions`, `routeProviderRequest`, `sameModel`, `shouldShowTtsVoiceRow`, `TwoPaneModelPicker`, `useConsumerConnection`, `useConsumerStatus`, `useLlmConfig`, `useModelCatalog`, `useNetworkProvider`, `useRoomProviders`.

**Types**

`ConsumerStatusIndicatorProps`, `LlmLocalSettings`, `LlmSettingsLocalAdapter`, `LlmSettingsLocale`, `LlmSettingsMessages`, `LlmSettingsMicAdapter`, `LlmSettingsProps`, `LlmSettingsTask`, `LlmSettingsVoiceAdapter`, `NetworkProviderPeer`, `NetworkProviderStatus`, `ProviderPanelStatus`, `ProviderPeerInfo`, `ProviderRequestRouterDeps`, `ProviderSettings`, `ProviderStatusPanelProps`, `ReasoningEffort`, `RoomProvide`, `TaskModelV1`, `UseConsumerConnectionOptions`, `UseNetworkProviderOptions`, `UseNetworkProviderResult`, `UseRoomProvidersOptions`, `VoiceEngine`.


## `@tik-choco/mistai/identity`

**Values**

`clearDelegation`, `computePairingMac`, `createDidIdentity`, `delegationSigningPayload`, `didKeyFromEd25519PublicKey`, `didKeyFromPublicKeyMultibase`, `ed25519PublicKeyFromDidKey`, `formatPairingCode`, `generatePairingCode`, `isEd25519DidKey`, `loadDelegation`, `loadDelegationFor`, `normalizePairingCode`, `pairingMacKey`, `pairingRoomId`, `parseDelegation`, `parseStoredDidIdentity`, `publicDidIdentity`, `publicKeyMultibaseFromEd25519`, `requestDelegation`, `resolveWireSender`, `saveDelegation`, `SHARED_DELEGATION_KEY`, `signDelegation`, `signStringWithDidIdentity`, `signWireWithDelegation`, `stableStringify`, `subscribeDelegation`, `verifyDelegation`, `verifyStringWithDid`, `verifyWire`.

**Types**

`DelegationV1`, `DidIdentity`, `PairError`, `PairRequest`, `PairResponse`, `PublicDidIdentity`, `RequestDelegationOptions`, `ResolvedSender`.


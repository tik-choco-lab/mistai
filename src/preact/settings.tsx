// Shared "AI接続 / AI Network / タスク" settings UI (@tik-choco/mistai/preact),
// ported from tc-translate's src/components/SettingsModal.tsx +
// VoiceSettingsPanel.tsx so every tik-choco app can drop in the same 3-tab
// settings block instead of re-implementing it.
//
// Spec: protocol/docs/data-contracts (tc-docs/drafts/llm-settings-common-v1.md
// in the docs repo) — see that document for the full data-layer/UI rationale.
// This file intentionally keeps the same structure/behavior described there:
// flat provider/preset CRUD grids with inline edit-on-blur rows, a Room
// ID/consumer/provider network tab, and a tasks tab (既定 + app tasks + TTS/
// STT/mic) with per-row hover tooltips instead of standing hint paragraphs.
//
// Design: components here manage the shared `tc-shared-llm-config-v1` config
// (providers/presets/defaultPresetId/tts/stt/network.roomId) INTERNALLY via
// ../llm-config.js — apps never thread that config through props. Apps only
// supply small, serializable adapters for what's genuinely app-local: which
// preset/reasoning_effort each of their own tasks uses, the connection mode,
// network-provider participation + status, and (optionally) TTS/STT/mic row
// visibility plus a few DOM-dependent bits (voice list, mic device list) that
// only the app can reasonably own.
//
// Styling: class names are `mistai-` prefixed; import the default stylesheet
// via `@tik-choco/mistai/ui.css` (this module's rules live in the same
// src/preact/ui.css file as the status-panel components). Reads `--mistai-*`
// custom properties with sensible fallbacks, same convention as ui.tsx.

import { useEffect, useRef, useState } from "preact/hooks";
import { fetchModels, fetchVoices, OPENAI_TTS_VOICES } from "../openai.js";
import { MESSAGES_EN, MESSAGES_JA, type MistaiMessages } from "../messages.js";
import type { ConsumerStatus } from "../client.js";
import type { ProviderLogEntry } from "../provider.js";
import {
  ConsumerStatusIndicator,
  ProviderStatusPanel,
  type ProviderPeerInfo,
} from "./ui.js";
import {
  createPreset,
  createProvider,
  deletePreset,
  deleteProvider,
  emptyLlmConfig,
  isNetworkProviderBaseUrl,
  loadLlmConfig,
  NETWORK_VOICE_AUTO_MODEL,
  patchPreset,
  patchProvider,
  saveLlmConfig,
  setVoiceConfig,
  subscribeLlmConfig,
  type LlmProviderV1,
  type ModelPresetV1,
  type SharedLlmConfigV1,
  type VoiceConfigV1,
} from "../llm-config.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * reasoning_effort values offered per task. `'none'` is a real, always-sent
 * API value (explicitly disables reasoning on servers that support it), not
 * "omit the field".
 */
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";

export const REASONING_EFFORT_OPTIONS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

/** Structurally identical to `NetworkProviderStatus` (./index.ts) / `ProviderPanelStatus` (./ui.ts) — kept as its own alias here to avoid an import cycle with the package's preact entry point. */
export type LlmProviderRuntimeStatus = "idle" | "connecting" | "connected" | "error";

/** Structurally identical to `NetworkProviderPeer` (./index.ts) / `ProviderPeerInfo` (./ui.ts). */
export type LlmProviderRuntimePeer = { nodeId: string; connectedAt: number; isConsumer: boolean };

/** One app-defined LLM task row in the タスク tab (e.g. "Vision", "Practice", ...). The 既定 row is built into the component and not part of this list. */
export interface LlmSettingsTask {
  key: string;
  label: string;
  /** One-sentence description shown as a hover tooltip on the row label (`data-tip`), not a standing hint paragraph. */
  tip?: string;
  /** Id of the preset this task uses; `''` means "follow the default preset". */
  presetId: string;
  reasoningEffort: ReasoningEffort;
  onPresetChange(id: string): void;
  onReasoningEffortChange(effort: ReasoningEffort): void;
}

export type LlmConnectionMode = "api" | "network";

export interface LlmSettingsConnectionAdapter {
  mode: LlmConnectionMode;
  onModeChange(mode: LlmConnectionMode): void;
}

/** Shape of the library's `useNetworkProvider` hook result, accepted as-is for the AI Network tab's provider status panel. */
export interface LlmSettingsProviderStatus {
  status: LlmProviderRuntimeStatus;
  statusUpdatedAt?: number;
  errorMessage?: string | null;
  ownNodeId?: string | null;
  peers: LlmProviderRuntimePeer[];
  consumerCount: number;
  logs: ProviderLogEntry[];
}

export interface LlmSettingsProviderAdapter {
  enabled: boolean;
  onEnabledChange(next: boolean): void;
  /** Ids of shared-config presets currently advertised to the room. */
  sharedPresetIds: string[];
  onSharedPresetIdsChange(ids: string[]): void;
  /** Omit to hide the status panel (e.g. while the provider hook hasn't mounted yet). */
  status?: LlmSettingsProviderStatus;
}

export interface LlmSettingsMicDevice {
  deviceId: string;
  label: string;
}

export interface LlmSettingsVoiceAdapter {
  /** Present → show the TTS row. `voiceOptions` seeds the voice-name picker (e.g. a fetched or hardcoded list); the currently saved voice is always shown even if absent from this list. */
  tts?: { voiceOptions?: string[] };
  /** Present → show the STT row. */
  stt?: {};
  /** Present → show the microphone row. The app owns device enumeration (DOM-only, no reason to duplicate per consumer). */
  mic?: {
    deviceId: string;
    onChange(deviceId: string): void;
    devices: LlmSettingsMicDevice[];
  };
}

export interface LlmSettingsProps {
  /** App-local per-task preset/reasoning_effort assignments. The 既定 row is always shown in addition to these. */
  tasks: LlmSettingsTask[];
  defaultReasoningEffort: ReasoningEffort;
  onDefaultReasoningEffortChange(effort: ReasoningEffort): void;
  connection: LlmSettingsConnectionAdapter;
  /** Omit to hide the "provider として参加" card entirely. */
  provider?: LlmSettingsProviderAdapter;
  /** Consumer-side LLM Network connection state (e.g. from `ConsumerClient.status`), shown in the AI Network tab while `connection.mode === 'network'`. */
  consumerStatus?: ConsumerStatus;
  consumerStatusUpdatedAt?: number;
  voice?: LlmSettingsVoiceAdapter;
  messages?: Partial<LlmSettingsMessages>;
  lang?: "en" | "ja";
}

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

export interface LlmSettingsMessages {
  tabConnection: string;
  tabNetwork: string;
  tabTasks: string;
  connectionsHeading: string;
  presetsHeading: string;
  add: string;
  cancel: string;
  noConnectionsHint: string;
  noPresetsHint: string;
  labelPlaceholder: string;
  apiKeyPlaceholder: string;
  baseUrlPlaceholder: string;
  selectConnectionPlaceholder: string;
  selectModelPlaceholder: string;
  modelNamePlaceholder: string;
  modelsLoading: string;
  modelFetchError: string;
  modelSelectConnectionFirst: string;
  addConnectionTile: string;
  addModelTile: string;
  addModelNeedConnection: string;
  connectionDelete: string;
  connectionDeleteConfirm: (count: number) => string;
  connectionNetworkNote: string;
  presetDelete: string;
  presetDeleteConfirm: string;
  presetUnknownConnection: string;
  presetUnsetOption: string;
  presetDefaultBadge: string;
  presetNetworkBadge: string;
  presetSharedBadge: string;
  presetTemperatureLabel: string;
  reasoningEffortLabel: string;
  taskDefaultLabel: string;
  taskDefaultTip: string;
  sameAsDefaultOption: string;
  networkTabHint: string;
  roomIdLabel: string;
  roomIdPlaceholder: string;
  networkConsumerToggle: string;
  networkConsumerHint: string;
  networkAutoImportHint: string;
  networkProviderToggle: string;
  networkProviderHint: string;
  networkShareHeading: string;
  networkShareEmpty: string;
  voiceTtsHeading: string;
  voiceTtsTip: string;
  voiceTtsVoiceLabel: string;
  voiceProviderDefaultOption: string;
  voiceSttHeading: string;
  voiceSttTip: string;
  voiceModelBrowserOption: string;
  voiceModelNetworkAutoOption: string;
  voiceConnectionUnresolved: string;
  voiceSttUnresolvedFallback: string;
  voiceSttModelMissing: string;
  voiceMicLabel: string;
  voiceMicDefaultOption: string;
}

export const LLM_SETTINGS_MESSAGES_EN: LlmSettingsMessages = {
  tabConnection: "AI Connection",
  tabNetwork: "AI Network",
  tabTasks: "Tasks",
  connectionsHeading: "Connections",
  presetsHeading: "Models",
  add: "Add",
  cancel: "Cancel",
  noConnectionsHint: "No connections yet. Click Add to create one.",
  noPresetsHint: "No models yet. Add a connection first, then click Add here.",
  labelPlaceholder: "Label (optional)",
  apiKeyPlaceholder: "API key",
  baseUrlPlaceholder: "https://...",
  selectConnectionPlaceholder: "Select a connection...",
  selectModelPlaceholder: "Select a model...",
  modelNamePlaceholder: "Model name",
  modelsLoading: "Loading…",
  modelFetchError: "Could not fetch the model list. Enter a model name manually.",
  modelSelectConnectionFirst: "Select a connection first",
  addConnectionTile: "Add connection",
  addModelTile: "Add model",
  addModelNeedConnection: "Add a connection first",
  connectionDelete: "Delete connection",
  connectionDeleteConfirm: (count) =>
    `This connection is used by ${count} model(s)/voice setting(s). Deleting it will break them. Delete anyway?`,
  connectionNetworkNote: "AI Network room",
  presetDelete: "Delete model",
  presetDeleteConfirm: "Delete this model? Any task using it will fall back to the default.",
  presetUnknownConnection: "(unknown)",
  presetUnsetOption: "Not set",
  presetDefaultBadge: "Default",
  presetNetworkBadge: "Network",
  presetSharedBadge: "Sharing",
  presetTemperatureLabel: "Temperature",
  reasoningEffortLabel: "reasoning_effort",
  taskDefaultLabel: "Default",
  taskDefaultTip: "Used wherever a task-specific model isn't set.",
  sameAsDefaultOption: "Same as default",
  networkTabHint: "Join a shared room to use models provided by peers, or share your own configured models with the room.",
  roomIdLabel: "Room ID",
  roomIdPlaceholder: "Room ID",
  networkConsumerToggle: "Use a network LLM",
  networkConsumerHint: "Route requests through a provider found in the room instead of your own connection.",
  networkAutoImportHint: "Models advertised by providers in this room are added to your models automatically.",
  networkProviderToggle: "Participate as a provider",
  networkProviderHint: "Serve your configured connections to other participants in this room.",
  networkShareHeading: "Models to share",
  networkShareEmpty: "No shareable models. Add one in the AI Connection tab first.",
  voiceTtsHeading: "TTS",
  voiceTtsTip: "Model used for text-to-speech.",
  voiceTtsVoiceLabel: "Voice",
  voiceProviderDefaultOption: "Provider default (not set)",
  voiceSttHeading: "STT",
  voiceSttTip: "Model used for speech-to-text.",
  voiceModelBrowserOption: "Browser default (not set)",
  voiceModelNetworkAutoOption: "AI Network (let the room decide)",
  voiceConnectionUnresolved: "This connection could not be resolved.",
  voiceSttUnresolvedFallback: "Falling back to the browser's built-in speech recognition.",
  voiceSttModelMissing: "No STT model is configured for this connection.",
  voiceMicLabel: "Microphone",
  voiceMicDefaultOption: "System default",
};

export const LLM_SETTINGS_MESSAGES_JA: LlmSettingsMessages = {
  tabConnection: "AI接続",
  tabNetwork: "AI Network",
  tabTasks: "タスク",
  connectionsHeading: "接続先",
  presetsHeading: "モデル",
  add: "追加",
  cancel: "キャンセル",
  noConnectionsHint: "まだ接続先がありません。「追加」から作成してください。",
  noPresetsHint: "まだモデルがありません。先に接続先を追加してから、ここで「追加」してください。",
  labelPlaceholder: "ラベル（省略可）",
  apiKeyPlaceholder: "APIキー",
  baseUrlPlaceholder: "https://...",
  selectConnectionPlaceholder: "接続先を選択...",
  selectModelPlaceholder: "モデルを選択...",
  modelNamePlaceholder: "モデル名",
  modelsLoading: "取得中…",
  modelFetchError: "モデル一覧を取得できませんでした。手入力してください。",
  modelSelectConnectionFirst: "先に接続先を選んでください",
  addConnectionTile: "接続先を追加",
  addModelTile: "モデルを追加",
  addModelNeedConnection: "先に接続先を追加してください",
  connectionDelete: "接続先を削除",
  connectionDeleteConfirm: (count) =>
    `この接続先は ${count} 件のモデル・音声設定で使われています。削除すると動作しなくなります。削除しますか？`,
  connectionNetworkNote: "AI Network ルーム",
  presetDelete: "モデルを削除",
  presetDeleteConfirm: "このモデルを削除しますか？使用しているタスクは既定にフォールバックします。",
  presetUnknownConnection: "（不明）",
  presetUnsetOption: "未設定",
  presetDefaultBadge: "既定",
  presetNetworkBadge: "Network",
  presetSharedBadge: "共有中",
  presetTemperatureLabel: "Temperature",
  reasoningEffortLabel: "reasoning_effort",
  taskDefaultLabel: "既定",
  taskDefaultTip: "タスク別のモデルが未設定のときに使われます。",
  sameAsDefaultOption: "既定と同じ",
  networkTabHint: "共有ルームに参加して他の参加者のモデルを使ったり、自分の接続をルームに提供したりできます。",
  roomIdLabel: "Room ID",
  roomIdPlaceholder: "Room ID",
  networkConsumerToggle: "ネットワークのLLMを使う",
  networkConsumerHint: "自分の接続の代わりに、ルーム内で見つかったproviderへリクエストを送ります。",
  networkAutoImportHint: "ルーム内のproviderが公開しているモデルは、自動でモデル一覧に追加されます。",
  networkProviderToggle: "providerとして参加",
  networkProviderHint: "設定済みの接続を、このルームの他の参加者に提供します。",
  networkShareHeading: "提供するモデル",
  networkShareEmpty: "提供できるモデルがありません。先に「AI接続」タブで追加してください。",
  voiceTtsHeading: "TTS",
  voiceTtsTip: "音声合成に使うモデルです。",
  voiceTtsVoiceLabel: "ボイス",
  voiceProviderDefaultOption: "provider既定（未指定）",
  voiceSttHeading: "STT",
  voiceSttTip: "音声認識に使うモデルです。",
  voiceModelBrowserOption: "ブラウザ標準（未設定）",
  voiceModelNetworkAutoOption: "AI Network（ルームにおまかせ）",
  voiceConnectionUnresolved: "この接続を解決できませんでした。",
  voiceSttUnresolvedFallback: "ブラウザ標準の音声認識にフォールバックします。",
  voiceSttModelMissing: "この接続にはSTTモデルが設定されていません。",
  voiceMicLabel: "マイク",
  voiceMicDefaultOption: "システム既定",
};

function resolveMessages(props: Pick<LlmSettingsProps, "messages" | "lang">): LlmSettingsMessages {
  const base = props.lang === "ja" ? LLM_SETTINGS_MESSAGES_JA : LLM_SETTINGS_MESSAGES_EN;
  return props.messages ? { ...base, ...props.messages } : base;
}

function resolveMistaiMessages(lang: "en" | "ja" | undefined): MistaiMessages {
  return lang === "ja" ? MESSAGES_JA : MESSAGES_EN;
}

// ---------------------------------------------------------------------------
// Shared config state
// ---------------------------------------------------------------------------

/**
 * Internal binding to `tc-shared-llm-config-v1`: each panel below manages its
 * own instance (apps never see this state). `save` applies a mutation to a
 * deep copy of the current config, persists it, and updates local state
 * immediately — `subscribeLlmConfig` only fires on the `storage` event, which
 * browsers do not dispatch back to the writing tab, so same-tab edits must be
 * reflected locally rather than waiting on that subscription.
 */
function useSharedLlmConfig(): {
  config: SharedLlmConfigV1;
  save: (mutate: (draft: SharedLlmConfigV1) => void) => void;
} {
  const [config, setConfig] = useState<SharedLlmConfigV1>(() => loadLlmConfig() ?? emptyLlmConfig());

  useEffect(() => subscribeLlmConfig((next) => setConfig(next ?? emptyLlmConfig())), []);

  function save(mutate: (draft: SharedLlmConfigV1) => void): void {
    setConfig((current) => {
      const draft: SharedLlmConfigV1 = JSON.parse(JSON.stringify(current)) as SharedLlmConfigV1;
      mutate(draft);
      saveLlmConfig(draft);
      return draft;
    });
  }

  return { config, save };
}

function getHostLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

// ---------------------------------------------------------------------------
// AI接続 (Connection) tab
// ---------------------------------------------------------------------------

export function LlmConnectionPanel(props: LlmSettingsProps) {
  const messages = resolveMessages(props);
  const { config, save } = useSharedLlmConfig();

  const [modelsByProviderId, setModelsByProviderId] = useState<Record<string, string[]>>({});
  const [loadingProviderId, setLoadingProviderId] = useState("");
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});

  const [editingProviderId, setEditingProviderId] = useState("");
  const [addingProvider, setAddingProvider] = useState(false);
  const [addingModel, setAddingModel] = useState(false);
  const [amProviderId, setAmProviderId] = useState("");
  const [amLabel, setAmLabel] = useState("");
  const [amModel, setAmModel] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  const [epProviderId, setEpProviderId] = useState("");

  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const mouseDownInsideRef = useRef(false);
  const fetchGenerationRef = useRef<Map<string, number>>(new Map());

  function closeAllInlineRows(): void {
    setEditingProviderId("");
    setAddingProvider(false);
    setEditingPresetId("");
    setAddingModel(false);
  }

  useEffect(() => {
    if (editingProviderId && !config.providers.some((p) => p.id === editingProviderId)) setEditingProviderId("");
    if (editingPresetId && !config.presets.some((p) => p.id === editingPresetId)) setEditingPresetId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.providers, config.presets]);

  useEffect(() => {
    if (!editingProviderId && !addingProvider && !editingPresetId && !addingModel) return undefined;

    function handleMouseDown(event: MouseEvent): void {
      mouseDownInsideRef.current = Boolean(activeRowRef.current && activeRowRef.current.contains(event.target as Node));
    }
    function handleClick(event: MouseEvent): void {
      if (activeRowRef.current && activeRowRef.current.contains(event.target as Node)) return;
      if (mouseDownInsideRef.current) return;
      closeAllInlineRows();
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") closeAllInlineRows();
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("click", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("click", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [editingProviderId, addingProvider, editingPresetId, addingModel]);

  async function fetchProviderModels(provider: LlmProviderV1): Promise<string[]> {
    const generations = fetchGenerationRef.current;
    const myGeneration = (generations.get(provider.id) || 0) + 1;
    generations.set(provider.id, myGeneration);
    const isStale = () => generations.get(provider.id) !== myGeneration;

    setLoadingProviderId(provider.id);
    setProviderModelErrors((current) => ({ ...current, [provider.id]: "" }));

    let models: string[] = [];
    try {
      models = await fetchModels({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    } catch {
      models = [];
    }

    if (isStale()) return models;
    setModelsByProviderId((current) => ({ ...current, [provider.id]: models }));
    if (models.length === 0) {
      setProviderModelErrors((current) => ({ ...current, [provider.id]: messages.modelFetchError }));
    }
    setLoadingProviderId((current) => (current === provider.id ? "" : current));
    return models;
  }

  function ensureProviderModelsFetched(providerId: string, options: { force?: boolean } = {}): void {
    if (!providerId) return;
    if (!options.force && modelsByProviderId[providerId] !== undefined) return;
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider || isNetworkProviderBaseUrl(provider.baseUrl)) return;
    void fetchProviderModels(provider);
  }

  function getModelSelectionState(providerId: string): { isLoading: boolean; models: string[]; mode: "select" | "manual" } {
    const isLoading = loadingProviderId === providerId;
    const models = modelsByProviderId[providerId] || [];
    return { isLoading, models, mode: isLoading || models.length > 0 ? "select" : "manual" };
  }

  function getProviderLabel(providerId: string): string {
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) return messages.presetUnknownConnection;
    return provider.label || getHostLabel(provider.baseUrl);
  }

  function isNetworkPresetProvider(providerId: string): boolean {
    const provider = config.providers.find((p) => p.id === providerId);
    return provider ? isNetworkProviderBaseUrl(provider.baseUrl) : false;
  }

  function getPresetBadges(preset: ModelPresetV1): string[] {
    const badges: string[] = [];
    if (config.defaultPresetId === preset.id) badges.push(messages.presetDefaultBadge);
    for (const task of props.tasks) {
      if (task.presetId === preset.id) badges.push(task.label);
    }
    if (isNetworkPresetProvider(preset.providerId)) badges.push(messages.presetNetworkBadge);
    if (props.provider?.sharedPresetIds.includes(preset.id)) badges.push(messages.presetSharedBadge);
    return badges;
  }

  // --- provider handlers -----------------------------------------------------

  function handleOpenAddProvider(): void {
    closeAllInlineRows();
    setAddingProvider(true);
  }

  function handleAddProvider(label: string, baseUrl: string, apiKey: string): void {
    const trimmedBaseUrl = baseUrl.trim().replace(/\/$/, "");
    if (!trimmedBaseUrl) return;
    save((draft) => {
      const id = createProvider(draft, label.trim());
      patchProvider(draft, id, { baseUrl: trimmedBaseUrl, apiKey });
    });
    setAddingProvider(false);
  }

  function handleUpdateProviderField(id: string, field: "label" | "baseUrl" | "apiKey", value: string): void {
    if (field === "baseUrl" && !value.trim()) return;
    save((draft) => patchProvider(draft, id, { [field]: value }));
    if (field === "baseUrl" || field === "apiKey") {
      setModelsByProviderId((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      const provider = config.providers.find((p) => p.id === id);
      const nextBaseUrl = field === "baseUrl" ? value : (provider?.baseUrl ?? "");
      if (provider && !isNetworkProviderBaseUrl(nextBaseUrl)) void fetchProviderModels({ ...provider, [field]: value });
    }
  }

  function handleRemoveProvider(provider: LlmProviderV1): void {
    const presetsUsing = config.presets.filter((p) => p.providerId === provider.id).length;
    if (presetsUsing > 0) {
      const ok = window.confirm(messages.connectionDeleteConfirm(presetsUsing));
      if (!ok) return;
    }
    save((draft) => deleteProvider(draft, provider.id));
    setModelsByProviderId((current) => {
      const next = { ...current };
      delete next[provider.id];
      return next;
    });
    if (editingProviderId === provider.id) setEditingProviderId("");
  }

  // --- preset handlers ---------------------------------------------------

  function handleOpenAddModel(): void {
    closeAllInlineRows();
    setAddingModel(true);
    setAmProviderId("");
    setAmLabel("");
    setAmModel("");
  }

  function handleAmProviderChange(providerId: string): void {
    setAmProviderId(providerId);
    setAmModel("");
    ensureProviderModelsFetched(providerId, { force: true });
  }

  function handleSaveAddModel(modelOverride?: string): void {
    const model = (modelOverride ?? amModel).trim();
    if (!amProviderId || !model) return;
    save((draft) => {
      const id = createPreset(draft, amProviderId, amLabel.trim() || model);
      patchPreset(draft, id, { model });
    });
    setAddingModel(false);
  }

  function handleOpenEditPreset(preset: ModelPresetV1): void {
    closeAllInlineRows();
    setEditingPresetId(preset.id);
    setEpProviderId(preset.providerId);
    ensureProviderModelsFetched(preset.providerId);
  }

  function handleRemovePreset(id: string): void {
    const ok = window.confirm(messages.presetDeleteConfirm);
    if (!ok) return;
    save((draft) => deletePreset(draft, id));
    if (editingPresetId === id) setEditingPresetId("");
  }

  // --- rendering -----------------------------------------------------------

  function renderProviderRow(provider: LlmProviderV1) {
    const isEditing = editingProviderId === provider.id;
    const isNetwork = isNetworkProviderBaseUrl(provider.baseUrl);
    const hostLabel = getHostLabel(provider.baseUrl);
    const secondLine = isNetwork ? messages.connectionNetworkNote : hostLabel;

    if (isEditing) {
      return (
        <div class="mistai-model-row mistai-model-row-editing" key={provider.id} ref={activeRowRef}>
          <div class="mistai-model-row-edit-fields">
            <input
              value={provider.label}
              onBlur={(event) => handleUpdateProviderField(provider.id, "label", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder={messages.labelPlaceholder}
              autoComplete="off"
            />
            <input
              value={provider.baseUrl}
              title={provider.baseUrl}
              onBlur={(event) => handleUpdateProviderField(provider.id, "baseUrl", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder={messages.baseUrlPlaceholder}
              autoComplete="off"
            />
            <input
              type="password"
              value={provider.apiKey || ""}
              onBlur={(event) => handleUpdateProviderField(provider.id, "apiKey", event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder={messages.apiKeyPlaceholder}
              autoComplete="off"
            />
            {providerModelErrors[provider.id] ? (
              <p class="mistai-hint mistai-connection-form-warning">{providerModelErrors[provider.id]}</p>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div class={`mistai-model-row${isNetwork ? " mistai-model-row-network" : ""}`} key={provider.id}>
        <button
          type="button"
          class="mistai-model-row-main"
          onClick={() => {
            closeAllInlineRows();
            setEditingProviderId(provider.id);
          }}
        >
          <span class="mistai-model-row-label">{provider.label || hostLabel}</span>
          <span class="mistai-model-row-model">{secondLine}</span>
        </button>
        <span
          class="mistai-chip-remove mistai-model-row-remove"
          role="button"
          tabIndex={0}
          title={messages.connectionDelete}
          onClick={(event) => {
            event.stopPropagation();
            handleRemoveProvider(provider);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              handleRemoveProvider(provider);
            }
          }}
        >
          ×
        </span>
      </div>
    );
  }

  function renderAddProviderTile() {
    if (!addingProvider) {
      return (
        <button type="button" class="mistai-grid-add-tile" onClick={handleOpenAddProvider}>
          + {messages.addConnectionTile}
        </button>
      );
    }
    let label = "";
    let baseUrl = "";
    let apiKey = "";
    return (
      <div class="mistai-model-row mistai-model-row-editing mistai-model-row-add" ref={activeRowRef}>
        <div class="mistai-model-row-edit-fields">
          <input onInput={(event) => (label = event.currentTarget.value)} placeholder={messages.labelPlaceholder} autoComplete="off" />
          <input onInput={(event) => (baseUrl = event.currentTarget.value)} placeholder={messages.baseUrlPlaceholder} autoComplete="off" />
          <input
            type="password"
            onInput={(event) => (apiKey = event.currentTarget.value)}
            placeholder={messages.apiKeyPlaceholder}
            autoComplete="off"
          />
        </div>
        <div class="mistai-model-row-add-actions">
          <button
            type="button"
            class="mistai-connection-form-btn mistai-connection-form-btn-primary"
            onClick={() => handleAddProvider(label, baseUrl, apiKey)}
          >
            {messages.add}
          </button>
          <button type="button" class="mistai-connection-form-btn" onClick={() => setAddingProvider(false)}>
            {messages.cancel}
          </button>
        </div>
      </div>
    );
  }

  function renderModelRow(preset: ModelPresetV1) {
    const isEditing = editingPresetId === preset.id;

    if (isEditing) {
      const { mode, isLoading, models } = getModelSelectionState(epProviderId);
      const modelError = epProviderId ? providerModelErrors[epProviderId] : "";
      return (
        <div class="mistai-model-row mistai-model-row-editing" key={preset.id} ref={activeRowRef}>
          <div class="mistai-model-row-edit-fields">
            <input
              value={preset.label}
              onBlur={(event) => {
                const label = event.currentTarget.value.trim() || preset.model;
                if (label !== preset.label) save((draft) => patchPreset(draft, preset.id, { label }));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              placeholder={messages.labelPlaceholder}
              autoComplete="off"
            />
            <select
              value={epProviderId}
              onChange={(event) => {
                const providerId = event.currentTarget.value;
                setEpProviderId(providerId);
                save((draft) => patchPreset(draft, preset.id, { providerId }));
                ensureProviderModelsFetched(providerId, { force: true });
              }}
            >
              {config.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label || getHostLabel(provider.baseUrl)}
                </option>
              ))}
            </select>
            <div class="mistai-connection-form-model-field">
              {mode === "select" ? (
                <select
                  value={preset.model}
                  onChange={(event) => {
                    save((draft) => patchPreset(draft, preset.id, { model: event.currentTarget.value }));
                    setEditingPresetId("");
                  }}
                >
                  <option value="" disabled>
                    {isLoading ? messages.modelsLoading : messages.selectModelPlaceholder}
                  </option>
                  {preset.model && !models.includes(preset.model) ? <option value={preset.model}>{preset.model}</option> : null}
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={preset.model}
                  onInput={(event) => save((draft) => patchPreset(draft, preset.id, { model: event.currentTarget.value }))}
                  onBlur={() => setEditingPresetId("")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                  placeholder={messages.modelNamePlaceholder}
                  autoComplete="off"
                />
              )}
            </div>
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              value={String(preset.temperature ?? 0.7)}
              onBlur={(event) => {
                const parsed = Number(event.currentTarget.value);
                if (Number.isFinite(parsed)) save((draft) => patchPreset(draft, preset.id, { temperature: parsed }));
              }}
              aria-label={messages.presetTemperatureLabel}
              title={messages.presetTemperatureLabel}
            />
            {modelError ? <p class="mistai-hint mistai-connection-form-warning">{modelError}</p> : null}
          </div>
        </div>
      );
    }

    const badges = getPresetBadges(preset);
    const isNetworkPreset = isNetworkPresetProvider(preset.providerId);
    return (
      <div class={`mistai-model-row${isNetworkPreset ? " mistai-model-row-network" : ""}`} key={preset.id}>
        <button type="button" class="mistai-model-row-main" onClick={() => handleOpenEditPreset(preset)}>
          <span class="mistai-model-row-label">{preset.label}</span>
          <span class="mistai-model-row-model">{preset.model}</span>
          <span class="mistai-model-row-provider">{getProviderLabel(preset.providerId)}</span>
        </button>
        {badges.length > 0 ? (
          <span class="mistai-model-row-badges">
            {badges.map((badge) => (
              <span key={badge} class="mistai-task-badge">
                {badge}
              </span>
            ))}
          </span>
        ) : null}
        <span
          class="mistai-chip-remove mistai-model-row-remove"
          role="button"
          tabIndex={0}
          title={messages.presetDelete}
          onClick={(event) => {
            event.stopPropagation();
            handleRemovePreset(preset.id);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              handleRemovePreset(preset.id);
            }
          }}
        >
          ×
        </span>
      </div>
    );
  }

  function renderAddModelTile() {
    if (config.providers.length === 0) {
      return (
        <button type="button" class="mistai-grid-add-tile" disabled title={messages.addModelNeedConnection}>
          + {messages.addModelTile}
        </button>
      );
    }
    if (!addingModel) {
      return (
        <button type="button" class="mistai-grid-add-tile" onClick={handleOpenAddModel}>
          + {messages.addModelTile}
        </button>
      );
    }

    const { mode, isLoading, models } = getModelSelectionState(amProviderId);
    const modelError = amProviderId ? providerModelErrors[amProviderId] : "";
    return (
      <div class="mistai-model-row mistai-model-row-editing mistai-model-row-add" ref={activeRowRef}>
        <div class="mistai-model-row-edit-fields">
          <input value={amLabel} onInput={(event) => setAmLabel(event.currentTarget.value)} placeholder={messages.labelPlaceholder} autoComplete="off" />
          <select value={amProviderId} onChange={(event) => handleAmProviderChange(event.currentTarget.value)}>
            <option value="" disabled>
              {messages.selectConnectionPlaceholder}
            </option>
            {config.providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label || getHostLabel(provider.baseUrl)}
              </option>
            ))}
          </select>
          <div class="mistai-connection-form-model-field">
            {!amProviderId ? (
              <select value="" disabled>
                <option value="">{messages.modelSelectConnectionFirst}</option>
              </select>
            ) : mode === "select" ? (
              <select
                value={amModel}
                onChange={(event) => {
                  setAmModel(event.currentTarget.value);
                  handleSaveAddModel(event.currentTarget.value);
                }}
              >
                <option value="" disabled>
                  {isLoading ? messages.modelsLoading : messages.selectModelPlaceholder}
                </option>
                {models.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={amModel}
                onInput={(event) => setAmModel(event.currentTarget.value)}
                onBlur={() => handleSaveAddModel()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                placeholder={messages.modelNamePlaceholder}
                autoComplete="off"
              />
            )}
          </div>
          {modelError ? <p class="mistai-hint mistai-connection-form-warning">{modelError}</p> : null}
        </div>
        <div class="mistai-model-row-add-actions">
          <button type="button" class="mistai-connection-form-btn" onClick={() => setAddingModel(false)}>
            {messages.cancel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="mistai-settings-tab-panel">
      <div class="mistai-server-list-header">
        <label>{messages.connectionsHeading}</label>
      </div>
      <div class="mistai-flat-section mistai-flat-section-connection">
        {config.providers.length === 0 && !addingProvider ? <p class="mistai-hint">{messages.noConnectionsHint}</p> : null}
        <div class="mistai-model-row-list">
          {config.providers.map((provider) => renderProviderRow(provider))}
          {renderAddProviderTile()}
        </div>
      </div>

      <div class="mistai-server-list-header">
        <label>{messages.presetsHeading}</label>
      </div>
      <div class="mistai-flat-section mistai-flat-section-models">
        {config.providers.length > 0 && config.presets.length === 0 && !addingModel ? (
          <p class="mistai-hint">{messages.noPresetsHint}</p>
        ) : null}
        <div class="mistai-model-row-list">
          {config.presets.map((preset) => renderModelRow(preset))}
          {renderAddModelTile()}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Network tab
// ---------------------------------------------------------------------------

export function LlmNetworkPanel(props: LlmSettingsProps) {
  const messages = resolveMessages(props);
  const mistaiMessages = resolveMistaiMessages(props.lang);
  const { config, save } = useSharedLlmConfig();
  const [roomIdDraft, setRoomIdDraft] = useState(config.network.roomId);

  useEffect(() => setRoomIdDraft(config.network.roomId), [config.network.roomId]);

  function commitRoomId(value: string): void {
    save((draft) => {
      draft.network.roomId = value;
    });
  }

  const eligiblePresets = config.presets.filter((preset) => {
    const provider = config.providers.find((entry) => entry.id === preset.providerId);
    return provider !== undefined && !isNetworkProviderBaseUrl(provider.baseUrl);
  });

  function getProviderLabel(providerId: string): string {
    const provider = config.providers.find((p) => p.id === providerId);
    if (!provider) return messages.presetUnknownConnection;
    return provider.label || getHostLabel(provider.baseUrl);
  }

  function handleToggleShareModel(presetId: string, checked: boolean): void {
    if (!props.provider) return;
    const current = props.provider.sharedPresetIds;
    const next = checked ? [...current, presetId] : current.filter((id) => id !== presetId);
    props.provider.onSharedPresetIdsChange(next);
  }

  return (
    <div class="mistai-settings-tab-panel">
      <p class="mistai-hint">{messages.networkTabHint}</p>

      <label class="mistai-room-id-row">
        <span>{messages.roomIdLabel}</span>
        <input
          value={roomIdDraft}
          onInput={(event) => setRoomIdDraft(event.currentTarget.value)}
          onBlur={(event) => commitRoomId(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          placeholder={messages.roomIdPlaceholder}
        />
      </label>

      <div class="mistai-role-group">
        <div class="mistai-role-card">
          <label class="mistai-role-head">
            <input
              type="checkbox"
              checked={props.connection.mode === "network"}
              onChange={(event) => props.connection.onModeChange(event.currentTarget.checked ? "network" : "api")}
            />
            <span class="mistai-role-title">{messages.networkConsumerToggle}</span>
          </label>
          <p class="mistai-role-desc">{messages.networkConsumerHint}</p>
          {props.connection.mode === "network" && props.consumerStatus ? (
            <div class="mistai-role-body">
              <ConsumerStatusIndicator
                status={props.consumerStatus}
                messages={mistaiMessages}
                updatedAt={props.consumerStatusUpdatedAt}
                variant="detailed"
              />
              <p class="mistai-role-desc">{messages.networkAutoImportHint}</p>
            </div>
          ) : null}
        </div>

        {props.provider ? (
          <div class="mistai-role-card">
            <label class="mistai-role-head">
              <input
                type="checkbox"
                checked={props.provider.enabled}
                onChange={(event) => props.provider?.onEnabledChange(event.currentTarget.checked)}
              />
              <span class="mistai-role-title">{messages.networkProviderToggle}</span>
            </label>
            <p class="mistai-role-desc">{messages.networkProviderHint}</p>
            {props.provider.enabled ? (
              <div class="mistai-role-body">
                <div class="mistai-share-section">
                  <label>{messages.networkShareHeading}</label>
                  {eligiblePresets.length === 0 ? (
                    <p class="mistai-hint">{messages.networkShareEmpty}</p>
                  ) : (
                    <div class="mistai-share-list">
                      {eligiblePresets.map((preset) => (
                        <label class="mistai-share-item" key={preset.id}>
                          <input
                            type="checkbox"
                            checked={props.provider?.sharedPresetIds.includes(preset.id) ?? false}
                            onChange={(event) => handleToggleShareModel(preset.id, event.currentTarget.checked)}
                          />
                          <span class="mistai-share-item-label">{preset.label || preset.model}</span>
                          <span class="mistai-share-item-model">
                            {preset.model} · {getProviderLabel(preset.providerId)}
                          </span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
                {props.provider.status ? (
                  <ProviderStatusPanel
                    status={props.provider.status.status}
                    messages={mistaiMessages}
                    statusUpdatedAt={props.provider.status.statusUpdatedAt}
                    errorMessage={props.provider.status.errorMessage}
                    ownNodeId={props.provider.status.ownNodeId}
                    peers={props.provider.status.peers as ProviderPeerInfo[]}
                    consumerCount={props.provider.status.consumerCount}
                    logs={props.provider.status.logs}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// タスク (Tasks) tab
// ---------------------------------------------------------------------------

function ReasoningEffortSelect(props: { value: ReasoningEffort; onChange: (effort: ReasoningEffort) => void; label: string }) {
  return (
    <div class="mistai-task-model-field">
      <select
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value as ReasoningEffort)}
        aria-label={props.label}
        title={props.label}
      >
        {REASONING_EFFORT_OPTIONS.map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Which kind of connection `config.tts`/`config.stt` currently resolves to. */
export type VoiceEngine = "browser" | "network" | "api";

/**
 * Pure, testable resolution of the connection `config[kind]` resolves to and
 * which "engine" that implies — mirrors `resolveVoice` (llm-config.ts)'s own
 * fallback-to-default-preset's-provider rule, so the row always reflects
 * what a real request would actually resolve to: `'browser'` when no model
 * is set at all, `'network'` when the resolved provider is the
 * `mist-network://` pseudo-provider (covers both a specific advertised
 * preset and the "AI Networkにおまかせ" auto sentinel), otherwise `'api'`.
 */
export function resolveVoiceEngine(
  config: SharedLlmConfigV1,
  cfg: VoiceConfigV1 | undefined,
): { baseUrl: string; apiKey: string; engine: VoiceEngine } {
  const model = cfg?.model ?? "";
  const provider = cfg?.providerId
    ? config.providers.find((entry) => entry.id === cfg.providerId)
    : config.providers.find((entry) => entry.id === config.presets.find((p) => p.id === config.defaultPresetId)?.providerId);
  const baseUrl = provider?.baseUrl ?? "";
  const apiKey = provider?.apiKey ?? "";
  const engine: VoiceEngine = !model.trim() ? "browser" : isNetworkProviderBaseUrl(baseUrl) ? "network" : "api";
  return { baseUrl, apiKey, engine };
}

/**
 * Whether the TTS voice picker should be shown for a row at all (§2.4 of
 * tts-voice-selection-v1): only when the app supplies a `voice.tts` adapter
 * at all, and never for the browser engine (there's no wire-level "voice"
 * concept there — `SpeechSynthesisUtterance` picks its own). Unlike the
 * previous behavior, this no longer excludes the `network-auto` ("AI
 * Networkにおまかせ") case — the model can be left to the room while the
 * voice is still pinned.
 */
export function shouldShowTtsVoiceRow(hasTtsAdapter: boolean, engine: VoiceEngine): boolean {
  return hasTtsAdapter && engine !== "browser";
}

/**
 * Resolves the voice-name choices offered by the TTS picker for the current
 * engine (§2.4):
 *  - `network`: the room's advertised union (`consumerStatus.voices`, built
 *    by `unionVoices` in ../client.ts from every connected TTS provider's
 *    `provider_hello.voices`). Never falls back to `OPENAI_TTS_VOICES` — a
 *    name the room doesn't actually support would mislead the user into
 *    picking it.
 *  - `api`: a live `fetchVoices()` result if non-empty, else the
 *    app-supplied adapter list (`voice.tts.voiceOptions`), else
 *    `OPENAI_TTS_VOICES` as the final UI-only fallback.
 *  - `browser`: never rendered (see shouldShowTtsVoiceRow), so `[]`.
 */
export function resolveTtsVoiceOptions(params: {
  engine: VoiceEngine;
  consumerStatus?: ConsumerStatus;
  fetchedApiVoices: string[];
  adapterVoiceOptions?: string[];
}): string[] {
  if (params.engine === "network") {
    return params.consumerStatus?.phase === "connected" ? (params.consumerStatus.voices ?? []) : [];
  }
  if (params.engine === "api") {
    if (params.fetchedApiVoices.length > 0) return params.fetchedApiVoices;
    if (params.adapterVoiceOptions && params.adapterVoiceOptions.length > 0) return params.adapterVoiceOptions;
    return OPENAI_TTS_VOICES;
  }
  return [];
}

/**
 * The full ordered list of `<option>` values for the TTS voice `<select>`:
 * the "provider default" sentinel (`''`, §2.4 — voice omitted, provider
 * answers with its own configured voice) always first, then the currently
 * saved voice if `voiceOptions` doesn't already include it (so a value
 * written by another app/session, or one the current engine's catalog
 * doesn't happen to advertise, stays visible and selected instead of
 * silently reverting to the default), then the offered choices.
 */
export function buildTtsVoiceOptionValues(voiceOptions: string[], currentVoice: string): string[] {
  const extra = currentVoice && !voiceOptions.includes(currentVoice) ? [currentVoice] : [];
  return ["", ...extra, ...voiceOptions];
}

export function LlmTasksPanel(props: LlmSettingsProps) {
  const messages = resolveMessages(props);
  const { config, save } = useSharedLlmConfig();

  const networkVoiceProviderId = config.providers.find((provider) => isNetworkProviderBaseUrl(provider.baseUrl))?.id ?? "";

  // Drives the TTS voice picker's 'api' engine choices: fetched once per
  // resolved (engine, baseUrl, apiKey) tuple rather than on every render, and
  // reset (not left stale) when the row isn't in 'api' mode at all so a
  // provider->network switch doesn't keep showing a prior server's voices.
  const { baseUrl: ttsBaseUrl, apiKey: ttsApiKey, engine: ttsEngine } = resolveVoiceEngine(config, config.tts);
  const [fetchedApiVoices, setFetchedApiVoices] = useState<string[]>([]);
  useEffect(() => {
    if (ttsEngine !== "api" || !ttsBaseUrl.trim()) {
      setFetchedApiVoices([]);
      return;
    }
    let cancelled = false;
    void fetchVoices(ttsBaseUrl, ttsApiKey).then((voices) => {
      if (!cancelled) setFetchedApiVoices(voices);
    });
    return () => {
      cancelled = true;
    };
  }, [ttsEngine, ttsBaseUrl, ttsApiKey]);

  function renderPresetTaskRow(key: string, label: string, tip: string, presetId: string, onPresetChange: (id: string) => void, effort: ReasoningEffort, onEffortChange: (effort: ReasoningEffort) => void, unsetLabel: string) {
    return (
      <div class="mistai-task-model-item" key={key}>
        <span data-tip={tip}>{label}</span>
        <div class="mistai-task-model-fields">
          <div class="mistai-task-model-field">
            <select value={presetId} onChange={(event) => onPresetChange(event.currentTarget.value)} aria-label={label}>
              <option value="">{unsetLabel}</option>
              {config.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label || preset.id}
                </option>
              ))}
            </select>
          </div>
          <ReasoningEffortSelect value={effort} onChange={onEffortChange} label={messages.reasoningEffortLabel} />
        </div>
      </div>
    );
  }

  function renderVoiceRow(kind: "tts" | "stt") {
    const cfg = config[kind];
    const model = cfg?.model ?? "";
    const providerId = cfg?.providerId;
    const matchedPreset = config.presets.find((preset) => preset.providerId === providerId && preset.model === model);
    const isNetworkAuto = networkVoiceProviderId !== "" && providerId === networkVoiceProviderId && model === NETWORK_VOICE_AUTO_MODEL;
    const selectValue = isNetworkAuto ? "__network__" : matchedPreset ? matchedPreset.id : model.trim() && model !== NETWORK_VOICE_AUTO_MODEL ? "__current__" : "";

    function handleChange(value: string): void {
      if (value === "__current__") return;
      if (value === "") {
        save((draft) => setVoiceConfig(draft, kind, { model: "" }));
        return;
      }
      if (value === "__network__") {
        save((draft) => setVoiceConfig(draft, kind, { providerId: networkVoiceProviderId, model: NETWORK_VOICE_AUTO_MODEL }));
        return;
      }
      const preset = config.presets.find((entry) => entry.id === value);
      if (!preset) return;
      save((draft) => setVoiceConfig(draft, kind, { providerId: preset.providerId, model: preset.model }));
    }

    const heading = kind === "tts" ? messages.voiceTtsHeading : messages.voiceSttHeading;
    const tip = kind === "tts" ? messages.voiceTtsTip : messages.voiceSttTip;
    const { baseUrl, engine } = resolveVoiceEngine(config, cfg);

    const showTtsVoiceRow = kind === "tts" && shouldShowTtsVoiceRow(Boolean(props.voice?.tts), engine);
    const ttsVoiceOptions = showTtsVoiceRow
      ? resolveTtsVoiceOptions({
          engine,
          consumerStatus: props.consumerStatus,
          fetchedApiVoices,
          adapterVoiceOptions: props.voice?.tts?.voiceOptions,
        })
      : [];

    return (
      <>
        <div class="mistai-task-model-item" key={kind}>
          <span data-tip={tip}>{heading}</span>
          <div class="mistai-task-model-fields">
            <div class="mistai-task-model-field">
              <select value={selectValue} onChange={(event) => handleChange(event.currentTarget.value)} aria-label={heading}>
                <option value="">{messages.voiceModelBrowserOption}</option>
                {networkVoiceProviderId ? <option value="__network__">{messages.voiceModelNetworkAutoOption}</option> : null}
                {model.trim() && !matchedPreset && !isNetworkAuto ? <option value="__current__">{model}</option> : null}
                {config.presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label || preset.model || preset.id}
                  </option>
                ))}
              </select>
            </div>
            {showTtsVoiceRow ? (
              <div class="mistai-task-model-field">
                <select
                  value={cfg?.voice ?? ""}
                  onChange={(event) => save((draft) => setVoiceConfig(draft, "tts", { ...draft.tts, model: draft.tts?.model ?? "", voice: event.currentTarget.value }))}
                  aria-label={messages.voiceTtsVoiceLabel}
                >
                  {buildTtsVoiceOptionValues(ttsVoiceOptions, cfg?.voice ?? "").map((value) => (
                    <option key={value || "__default__"} value={value}>
                      {value === "" ? messages.voiceProviderDefaultOption : value}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </div>
        {kind === "tts" && engine === "api" && !baseUrl.trim() ? <p class="mistai-error-text">{messages.voiceConnectionUnresolved}</p> : null}
        {kind === "stt" && engine === "api" && !baseUrl.trim() ? (
          <p class="mistai-error-text">{`${messages.voiceConnectionUnresolved} ${messages.voiceSttUnresolvedFallback}`}</p>
        ) : null}
        {kind === "stt" && engine === "api" && baseUrl.trim() && !model.trim() ? (
          <p class="mistai-error-text">{`${messages.voiceSttModelMissing} ${messages.voiceSttUnresolvedFallback}`}</p>
        ) : null}
      </>
    );
  }

  return (
    <div class="mistai-settings-tab-panel">
      {renderPresetTaskRow(
        "default",
        messages.taskDefaultLabel,
        messages.taskDefaultTip,
        config.defaultPresetId,
        (id) => save((draft) => (draft.defaultPresetId = id)),
        props.defaultReasoningEffort,
        props.onDefaultReasoningEffortChange,
        messages.presetUnsetOption,
      )}

      {props.tasks.map((task) =>
        renderPresetTaskRow(
          task.key,
          task.label,
          task.tip ?? "",
          task.presetId,
          task.onPresetChange,
          task.reasoningEffort,
          task.onReasoningEffortChange,
          messages.sameAsDefaultOption,
        ),
      )}

      {props.voice?.tts ? renderVoiceRow("tts") : null}
      {props.voice?.stt ? renderVoiceRow("stt") : null}

      {props.voice?.mic ? (
        <div class="mistai-task-model-item">
          <span>{messages.voiceMicLabel}</span>
          <div class="mistai-task-model-fields">
            <div class="mistai-task-model-field">
              <select
                value={props.voice.mic.deviceId}
                onChange={(event) => props.voice?.mic?.onChange(event.currentTarget.value)}
                aria-label={messages.voiceMicLabel}
              >
                <option value="">{messages.voiceMicDefaultOption}</option>
                {props.voice.mic.devices.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabbed wrapper
// ---------------------------------------------------------------------------

type SettingsTab = "connection" | "network" | "tasks";

/**
 * The full 3-tab settings block (AI接続 / AI Network / タスク). Apps that want
 * to lay the tabs out differently (or embed only one) can render
 * `LlmConnectionPanel`/`LlmNetworkPanel`/`LlmTasksPanel` directly instead.
 */
export function LlmSettings(props: LlmSettingsProps) {
  const messages = resolveMessages(props);
  const [activeTab, setActiveTab] = useState<SettingsTab>("connection");

  const tabs: Array<{ id: SettingsTab; label: string }> = [
    { id: "connection", label: messages.tabConnection },
    { id: "network", label: messages.tabNetwork },
    { id: "tasks", label: messages.tabTasks },
  ];

  return (
    <div class="mistai-settings">
      <div class="mistai-settings-tabs" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            class={`mistai-settings-tab${activeTab === tab.id ? " active" : ""}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "connection" ? <LlmConnectionPanel {...props} /> : null}
      {activeTab === "network" ? <LlmNetworkPanel {...props} /> : null}
      {activeTab === "tasks" ? <LlmTasksPanel {...props} /> : null}
    </div>
  );
}

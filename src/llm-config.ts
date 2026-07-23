// Shared LLM/TTS/STT connection config for the tik-choco app family, vendored
// identically (modulo TS/JS syntax) into every participating app. This is the
// canonical library copy — apps should import from
// `@tik-choco/mistai/llm-config` instead of vendoring their own. See
// protocol/docs/data-contracts/docs/llm-config.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib, preact, or any transport.
// Unlike a writer-owned key, this key is co-owned: every participating app
// reads AND writes the same localStorage record, so a user only has to enter
// their LLM endpoint/API key once per origin instead of once per app.
// Same-origin apps mutually trust each other; conflicts are resolved
// last-write-wins by `updatedAt`.
//
// Merge/migration policy (enforced by convention, not code): apps seeding
// this config from their own legacy local settings must loadLlmConfig() (or
// start from emptyLlmConfig() if null), add entries via ensureProvider/
// ensurePreset (which only ever append, never delete or overwrite existing
// entries), set `defaultPresetId`/`tts`/`stt`/`network.roomId` ONLY if
// currently empty/absent, then call saveLlmConfig(). Never blind-overwrite
// another app's providers/presets.
//
// This is the canonical reference copy
// (protocol/docs/data-contracts/reference/llmConfig.ts). Don't hand-edit the
// vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead. Like appManifest.ts, this file
// has no per-app placeholder to substitute: the vendored copy is
// byte-identical everywhere.

export const LLM_CONFIG_KEY = "tc-shared-llm-config-v1";
export const LLM_CONFIG_VERSION = 1;

/** 接続情報のみ = 「どこに繋ぐか」 */
export type LlmProviderV1 = {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
};

/** 名前付きモデル設定 = 「どう呼ぶか」。providerId で LlmProviderV1 を参照 */
export type ModelPresetV1 = {
  id: string;
  label: string;
  providerId: string;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
};

/** TTS/STT。providerId 省略時は defaultPreset の provider にフォールバック */
export type VoiceConfigV1 = {
  providerId?: string;
  model: string;
  voice?: string;
  speed?: number;
};

export type SharedLlmConfigV1 = {
  v: 1;
  providers: LlmProviderV1[];
  presets: ModelPresetV1[];
  /** ""(空文字)= 未設定 */
  defaultPresetId: string;
  tts?: VoiceConfigV1;
  stt?: VoiceConfigV1;
  /** AI Network の既定ルーム。roomId: "" = 未設定 */
  network: { roomId: string };
  /** ISO 8601、LWW(last-write-wins)用 */
  updatedAt: string;
};

/** resolvePreset() の解決結果。provider の接続情報と preset のモデル設定を1つにマージしたもの。 */
export type ResolvedLlmTargetV1 = {
  presetId: string;
  providerId: string;
  /** preset の label */
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  reasoningEffort?: string;
};

function isLlmProviderV1(value: unknown): value is LlmProviderV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.baseUrl === "string" &&
    typeof record.apiKey === "string"
  );
}

function isModelPresetV1(value: unknown): value is ModelPresetV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.providerId === "string" &&
    typeof record.model === "string" &&
    (record.temperature === undefined || typeof record.temperature === "number") &&
    (record.reasoningEffort === undefined || typeof record.reasoningEffort === "string")
  );
}

function isVoiceConfigV1(value: unknown): value is VoiceConfigV1 {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    (record.providerId === undefined || typeof record.providerId === "string") &&
    typeof record.model === "string" &&
    (record.voice === undefined || typeof record.voice === "string") &&
    (record.speed === undefined || typeof record.speed === "number")
  );
}

/**
 * Field-by-field defensive parse of a raw `SharedLlmConfigV1` value. Returns
 * null if a required top-level field is missing/malformed or `v` isn't 1.
 * Malformed entries inside `providers`/`presets` are dropped individually
 * rather than invalidating the whole record; a malformed optional `tts`/`stt`
 * is dropped the same way.
 */
function sanitizeLlmConfig(value: unknown): SharedLlmConfigV1 | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;

  if (record.v !== 1) return null;
  if (!Array.isArray(record.providers)) return null;
  if (!Array.isArray(record.presets)) return null;
  if (typeof record.defaultPresetId !== "string") return null;
  if (record.network === null || typeof record.network !== "object") return null;
  const network = record.network as Record<string, unknown>;
  if (typeof network.roomId !== "string") return null;
  if (typeof record.updatedAt !== "string") return null;

  const config: SharedLlmConfigV1 = {
    v: 1,
    providers: record.providers.filter(isLlmProviderV1),
    presets: record.presets.filter(isModelPresetV1),
    defaultPresetId: record.defaultPresetId,
    network: { roomId: network.roomId },
    updatedAt: record.updatedAt,
  };

  if (record.tts !== undefined && isVoiceConfigV1(record.tts)) config.tts = record.tts;
  if (record.stt !== undefined && isVoiceConfigV1(record.stt)) config.stt = record.stt;

  return config;
}

function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through to the Math.random fallback below
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Returns a fresh, empty `SharedLlmConfigV1` (not persisted). */
export function emptyLlmConfig(): SharedLlmConfigV1 {
  return {
    v: 1,
    providers: [],
    presets: [],
    defaultPresetId: "",
    network: { roomId: "" },
    updatedAt: "",
  };
}

/**
 * Reads and validates `tc-shared-llm-config-v1`. Returns null if the key is
 * missing, the JSON is malformed, or the shape doesn't match
 * `SharedLlmConfigV1` (never throws). See `sanitizeLlmConfig` for how
 * malformed array entries are handled.
 */
export function loadLlmConfig(): SharedLlmConfigV1 | null {
  try {
    const raw = localStorage.getItem(LLM_CONFIG_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return sanitizeLlmConfig(parsed);
  } catch {
    return null;
  }
}

/**
 * Persists `config` to `tc-shared-llm-config-v1`, stamping `config.updatedAt`
 * with the current time (mutates the passed object). Never throws: storage
 * failures (quota, disabled storage, etc.) are swallowed after a
 * console.warn.
 */
export function saveLlmConfig(config: SharedLlmConfigV1): void {
  config.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
  } catch (error) {
    console.warn("tc-shared-llm-config: failed to persist config", error);
  }
}

/**
 * Subscribes to cross-tab/cross-app updates of `tc-shared-llm-config-v1` via
 * the `storage` window event (same-origin only, and only fires for tabs
 * other than the writer). Calls `cb` with the freshly loaded config (or null)
 * whenever the key changes. Returns an unsubscribe function.
 */
export function subscribeLlmConfig(cb: (config: SharedLlmConfigV1 | null) => void): () => void {
  function onStorageEvent(event: StorageEvent) {
    if (event.key !== LLM_CONFIG_KEY) return;
    cb(loadLlmConfig());
  }

  window.addEventListener("storage", onStorageEvent);
  return () => window.removeEventListener("storage", onStorageEvent);
}

/** Trims whitespace and strips trailing slashes, so equivalent endpoints compare equal. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Finds-or-creates a provider by (normalized baseUrl, apiKey) pair. Mutates
 * `config.providers` in place (push-only, never overwrites an existing
 * entry) and returns the provider's id; the caller is responsible for
 * calling `saveLlmConfig` afterwards.
 */
export function ensureProvider(
  config: SharedLlmConfigV1,
  input: { label?: string; baseUrl: string; apiKey: string },
): string {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = config.providers.find((p) => p.baseUrl === baseUrl && p.apiKey === input.apiKey);
  if (existing) return existing.id;

  const id = newId();
  config.providers.push({ id, label: input.label || baseUrl, baseUrl, apiKey: input.apiKey });
  return id;
}

/**
 * Finds-or-creates a preset. If `input.id` is given and a preset with that id
 * already exists, it is returned unchanged (an explicit id is never
 * overwritten). Otherwise dedupes by
 * `(providerId, model, temperature ?? null, reasoningEffort ?? null)`.
 * Mutates `config.presets` in place (push-only); the caller is responsible
 * for calling `saveLlmConfig` afterwards.
 */
export function ensurePreset(
  config: SharedLlmConfigV1,
  input: {
    id?: string;
    label?: string;
    providerId: string;
    model: string;
    temperature?: number;
    reasoningEffort?: string;
  },
): string {
  if (input.id) {
    const byId = config.presets.find((p) => p.id === input.id);
    if (byId) return byId.id;
  }

  const temperature = input.temperature ?? null;
  const reasoningEffort = input.reasoningEffort ?? null;
  const existing = config.presets.find(
    (p) =>
      p.providerId === input.providerId &&
      p.model === input.model &&
      (p.temperature ?? null) === temperature &&
      (p.reasoningEffort ?? null) === reasoningEffort,
  );
  if (existing) return existing.id;

  const preset: ModelPresetV1 = {
    id: input.id ?? newId(),
    label: input.label || input.model,
    providerId: input.providerId,
    model: input.model,
  };
  if (input.temperature !== undefined) preset.temperature = input.temperature;
  if (input.reasoningEffort !== undefined) preset.reasoningEffort = input.reasoningEffort;

  config.presets.push(preset);
  return preset.id;
}

/**
 * Resolves `presetId` (or, if omitted/not found, `config.defaultPresetId`)
 * to a preset and merges it with its provider's connection info. Returns
 * null if no preset can be found or its provider no longer exists.
 */
export function resolvePreset(config: SharedLlmConfigV1, presetId?: string | null): ResolvedLlmTargetV1 | null {
  const preset =
    (presetId ? config.presets.find((p) => p.id === presetId) : undefined) ??
    config.presets.find((p) => p.id === config.defaultPresetId);
  if (!preset) return null;

  const provider = config.providers.find((p) => p.id === preset.providerId);
  if (!provider) return null;

  const resolved: ResolvedLlmTargetV1 = {
    presetId: preset.id,
    providerId: provider.id,
    label: preset.label,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: preset.model,
  };
  if (preset.temperature !== undefined) resolved.temperature = preset.temperature;
  if (preset.reasoningEffort !== undefined) resolved.reasoningEffort = preset.reasoningEffort;
  return resolved;
}

/**
 * Resolves `config.tts`/`config.stt` to concrete connection info. Returns
 * null if the voice config is absent, has no `model`, or its provider (the
 * explicit `providerId`, or else the provider of `resolvePreset(config)`)
 * can't be found.
 */
export function resolveVoice(
  config: SharedLlmConfigV1,
  kind: "tts" | "stt",
): { baseUrl: string; apiKey: string; model: string; voice?: string; speed?: number } | null {
  const cfg = config[kind];
  if (!cfg || !cfg.model) return null;

  const provider = cfg.providerId
    ? config.providers.find((p) => p.id === cfg.providerId)
    : (() => {
        const defaultTarget = resolvePreset(config);
        return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
      })();
  if (!provider) return null;

  const resolved: { baseUrl: string; apiKey: string; model: string; voice?: string; speed?: number } = {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: cfg.model,
  };
  if (cfg.voice !== undefined) resolved.voice = cfg.voice;
  if (cfg.speed !== undefined) resolved.speed = cfg.speed;
  return resolved;
}

// ---------------------------------------------------------------------------
// Settings-UI CRUD helpers (ported from tc-translate's src/lib/llmConfigEdit.ts)
// ---------------------------------------------------------------------------
// A plain CRUD layer over `config.providers`/`config.presets`: add/update/
// delete acting directly on the array, as opposed to the append-only-dedup
// `ensureProvider`/`ensurePreset` above (which exist for one-time legacy
// migration / network-mirror sync). Settings UIs let the user explicitly
// manage a list of named connections and presets, so they should use these
// instead. Callers are responsible for calling `saveLlmConfig()` afterwards.

export function createProvider(config: SharedLlmConfigV1, label: string): string {
  const provider: LlmProviderV1 = { id: newId(), label, baseUrl: "", apiKey: "" };
  config.providers.push(provider);
  return provider.id;
}

export function patchProvider(config: SharedLlmConfigV1, id: string, patch: Partial<Omit<LlmProviderV1, "id">>): void {
  const provider = config.providers.find((entry) => entry.id === id);
  if (provider) Object.assign(provider, patch);
}

/** Removes a provider. Any preset still referencing it keeps its (now dangling) providerId - resolvePreset degrades that to "no target" rather than throwing. */
export function deleteProvider(config: SharedLlmConfigV1, id: string): void {
  config.providers = config.providers.filter((entry) => entry.id !== id);
}

export function createPreset(config: SharedLlmConfigV1, providerId: string, label: string): string {
  const preset: ModelPresetV1 = { id: newId(), label, providerId, model: "", temperature: 0.7 };
  config.presets.push(preset);
  // First preset ever created becomes the default automatically - otherwise
  // every role (default/vision/...) would keep resolving to nothing even
  // though a preset now exists.
  if (!config.defaultPresetId) config.defaultPresetId = preset.id;
  return preset.id;
}

export function patchPreset(config: SharedLlmConfigV1, id: string, patch: Partial<Omit<ModelPresetV1, "id">>): void {
  const preset = config.presets.find((entry) => entry.id === id);
  if (preset) Object.assign(preset, patch);
}

/** Removes a preset. If it was the default, the next remaining preset (if any) takes over; any app-local pointer referencing it (e.g. a per-task preset id) is left for the caller to clear. */
export function deletePreset(config: SharedLlmConfigV1, id: string): void {
  config.presets = config.presets.filter((entry) => entry.id !== id);
  if (config.defaultPresetId === id) config.defaultPresetId = config.presets[0]?.id ?? "";
}

/**
 * Updates `config.tts`/`config.stt` in place from Settings UI edits. An
 * empty `providerId` clears it (falls back to the default preset's
 * provider); an empty/absent `voice` omits it the same way. Fields this
 * function doesn't know about (currently just `speed`) are preserved from
 * the existing value rather than dropped — `next` only carries what the
 * voice-row UI actually edits, and another app may have set `speed`
 * independently in this same shared-localStorage record, so a plain
 * `config[kind] = next` here would silently discard it on every edit.
 */
export function setVoiceConfig(
  config: SharedLlmConfigV1,
  kind: "tts" | "stt",
  next: { providerId?: string; model: string; voice?: string },
): void {
  const previous = config[kind];
  config[kind] = {
    ...(previous?.speed !== undefined ? { speed: previous.speed } : {}),
    ...(next.providerId ? { providerId: next.providerId } : {}),
    model: next.model,
    ...(next.voice ? { voice: next.voice } : {}),
  };
}

// ---------------------------------------------------------------------------
// mist-network:// pseudo-provider conventions (ported from tc-translate's
// src/lib/networkModels.ts)
// ---------------------------------------------------------------------------
// Helpers for representing LLM Network–discovered models in the shared llm
// config: they live under a pseudo-provider whose baseUrl uses the
// `mist-network://` scheme (one per Room ID), so other tik-choco apps see a
// syntactically valid provider entry while an app that understands the
// convention can recognize and special-case it (no HTTP model fetch, network
// transport routing).

export const NETWORK_PROVIDER_LABEL = "AI Network";
export const NETWORK_PROVIDER_URL_PREFIX = "mist-network://";

export function networkProviderBaseUrl(roomId: string): string {
  return `${NETWORK_PROVIDER_URL_PREFIX}${roomId.trim() || "default"}`;
}

export function isNetworkProviderBaseUrl(baseUrl: string): boolean {
  return baseUrl.trim().startsWith(NETWORK_PROVIDER_URL_PREFIX);
}

/**
 * The name a shared preset is advertised under in `provider_hello.models`,
 * and the key incoming model-specific requests are matched back to a target
 * by: the preset's user-facing label, falling back to the raw model id when
 * the label is blank. Room-level convention: the advertised strings are
 * display names doubling as opaque routing keys, NOT necessarily upstream
 * model ids — consumers echo them back verbatim and only the provider that
 * advertised a name knows which upstream preset it maps to. Wire-compatible
 * with peers that advertise plain model ids (label defaults to the model
 * id).
 */
export function advertisedModelName(target: { label: string; model: string }): string {
  return target.label.trim() || target.model;
}

/** Sentinel voice-config model meaning "let the room's provider use its own configured TTS/STT model". Stored in the shared config's tts/stt model field alongside a mist-network pseudo-provider id; stripped from outgoing requests (an omitted wire model → provider's own default). */
export const NETWORK_VOICE_AUTO_MODEL = "network-auto";

/** Maps a configured voice model to the wire request param: the auto sentinel becomes undefined (omit), anything else passes through (empty → undefined too). */
export function networkVoiceModelParam(model: string): string | undefined {
  const trimmed = model.trim();
  return !trimmed || trimmed === NETWORK_VOICE_AUTO_MODEL ? undefined : trimmed;
}

export type NetworkMirrorConsolidation = {
  /** Whether `config` was mutated — callers should persist (and notify) only when true. */
  changed: boolean;
  /**
   * Maps a removed duplicate preset's id to the id of the surviving preset
   * it was merged into. `config.defaultPresetId` is already repointed
   * in-place when it named a removed id; a caller-owned reference living
   * outside `config` (e.g. an app's per-task preset-id override) is not —
   * that's the caller's job, using this map.
   */
  presetIdRemap: Map<string, string>;
};

/**
 * Self-heals `config`'s `mist-network://<roomId>` mirror for one room:
 * collapses any duplicate pseudo-provider rows (same normalized baseUrl,
 * apiKey `""`) into the first one (oldest, since `providers` is an
 * append-only array), and any duplicate presets found under them — same
 * advertised model name (trimmed) + temperature + reasoningEffort — into the
 * first one seen. Mutates `config` in place.
 *
 * Duplicates of this shape are never supposed to happen — `ensureProvider`/
 * `ensurePreset` above already dedup exactly (baseUrl+apiKey;
 * providerId+model+temperature+reasoningEffort) and are idempotent for a
 * single writer — but the shared config is co-owned with no locking
 * (last-write-wins by `updatedAt`; see this file's header comment): two
 * same-origin app instances (two tabs, or two apps) both mirroring the same
 * room can each `loadLlmConfig()` before the other's `saveLlmConfig()` lands
 * and each create their own row for what should be one entry. The
 * trimmed-model comparison additionally absorbs a provider that
 * re-advertises the "same" model with incidental whitespace differences
 * across reconnects, which would otherwise dedup-key as a distinct model and
 * never get pruned by an app's mirror-sync hook (whose own no-longer-
 * advertised prune only compares by exact model string).
 *
 * This is the one sanctioned exception to the shared config's "append-only,
 * never touch another app's entries" convention (see this file's
 * merge-policy comment): it only ever touches entries a mist-network://
 * mirror for THIS room would itself have created, collapsing them back to
 * the shape `ensureProvider`/`ensurePreset` would have produced with no
 * race — it never removes a real HTTP provider/preset another app added, and
 * never touches a different room's pseudo-provider.
 *
 * Callers (an app's own mirror-sync hook — see e.g. tc-lingo/tc-translate's
 * `useNetworkModelSync`) should run this on every mirror-sync tick (each
 * connect/reconnect, not just once behind a migration flag), so duplication
 * from any cause — including any that predates this function — gets cleaned
 * up the next time the room is actually joined. An app-local
 * `taskPresetIds`-style override that named a removed duplicate id is not
 * repointed here (this module has no notion of such app-specific state) —
 * the caller should repoint it using the returned `presetIdRemap`.
 */
export function consolidateNetworkMirror(config: SharedLlmConfigV1, roomId: string): NetworkMirrorConsolidation {
  const baseUrl = normalizeBaseUrl(networkProviderBaseUrl(roomId));
  const matchingProviders = config.providers.filter((p) => p.baseUrl === baseUrl && p.apiKey === "");
  const presetIdRemap = new Map<string, string>();
  if (matchingProviders.length === 0) return { changed: false, presetIdRemap };

  const survivor = matchingProviders[0];
  const matchingProviderIds = new Set(matchingProviders.map((p) => p.id));
  const extraProviderIds = new Set(matchingProviders.slice(1).map((p) => p.id));

  const keyOf = (p: ModelPresetV1) => `${p.model.trim()} ${p.temperature ?? ""} ${p.reasoningEffort ?? ""}`;
  const survivorByKey = new Map<string, ModelPresetV1>();

  for (const preset of config.presets) {
    if (!matchingProviderIds.has(preset.providerId)) continue;
    const key = keyOf(preset);
    const existing = survivorByKey.get(key);
    if (!existing) {
      survivorByKey.set(key, preset);
      // Adopt presets already sitting under an extra (soon-to-be-removed)
      // provider row into the survivor - keeps this preset's own id, so any
      // external reference to it (defaultPresetId, a per-task override)
      // stays valid without needing a remap entry.
      if (preset.providerId !== survivor.id) preset.providerId = survivor.id;
    } else {
      presetIdRemap.set(preset.id, existing.id);
    }
  }

  if (extraProviderIds.size === 0 && presetIdRemap.size === 0) return { changed: false, presetIdRemap };

  if (presetIdRemap.size > 0) config.presets = config.presets.filter((p) => !presetIdRemap.has(p.id));
  if (extraProviderIds.size > 0) config.providers = config.providers.filter((p) => !extraProviderIds.has(p.id));

  const remappedDefault = presetIdRemap.get(config.defaultPresetId);
  if (remappedDefault) config.defaultPresetId = remappedDefault;

  return { changed: true, presetIdRemap };
}

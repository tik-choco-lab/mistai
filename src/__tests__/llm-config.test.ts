import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLM_CONFIG_KEY,
  NETWORK_PROVIDER_URL_PREFIX,
  NETWORK_VOICE_AUTO_MODEL,
  advertisedModelName,
  consolidateNetworkMirror,
  createPreset,
  createProvider,
  deletePreset,
  deleteProvider,
  emptyLlmConfig,
  ensurePreset,
  ensureProvider,
  isNetworkProviderBaseUrl,
  loadLlmConfig,
  networkProviderBaseUrl,
  networkVoiceModelParam,
  normalizeBaseUrl,
  patchPreset,
  patchProvider,
  resolvePreset,
  resolveVoice,
  saveLlmConfig,
  setVoiceConfig,
  subscribeLlmConfig,
  type SharedLlmConfigV1,
} from "../llm-config.js";

function makeFakeStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
    _store: store,
  } as unknown as Storage & { _store: Map<string, string> };
}

/** Minimal EventTarget-backed `window` stub for subscribeLlmConfig, which is written against the DOM `storage` event and browser globals absent in vitest's default node environment. */
function makeFakeWindow() {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  };
}

describe("emptyLlmConfig", () => {
  it("returns a fresh, empty, valid config", () => {
    const config = emptyLlmConfig();
    expect(config).toEqual({
      v: 1,
      providers: [],
      presets: [],
      defaultPresetId: "",
      network: { roomId: "" },
      updatedAt: "",
    });
  });

  it("returns a distinct object on each call (not shared mutable state)", () => {
    const a = emptyLlmConfig();
    const b = emptyLlmConfig();
    a.providers.push({ id: "x", label: "x", baseUrl: "x", apiKey: "" });
    expect(b.providers).toEqual([]);
  });
});

describe("loadLlmConfig / saveLlmConfig round trip", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null when the key is missing", () => {
    vi.stubGlobal("localStorage", makeFakeStorage());
    expect(loadLlmConfig()).toBeNull();
  });

  it("returns null on malformed JSON without throwing", () => {
    const storage = makeFakeStorage();
    storage.setItem(LLM_CONFIG_KEY, "{not json");
    vi.stubGlobal("localStorage", storage);
    expect(loadLlmConfig()).toBeNull();
  });

  it("returns null when v is not 1", () => {
    const storage = makeFakeStorage();
    storage.setItem(LLM_CONFIG_KEY, JSON.stringify({ ...emptyLlmConfig(), v: 2 }));
    vi.stubGlobal("localStorage", storage);
    expect(loadLlmConfig()).toBeNull();
  });

  it("drops malformed provider/preset entries individually instead of invalidating the whole record", () => {
    const storage = makeFakeStorage();
    const raw = {
      v: 1,
      providers: [
        { id: "p1", label: "ok", baseUrl: "https://a", apiKey: "" },
        { id: "p2", label: "missing baseUrl" }, // malformed
        "not-an-object", // malformed
      ],
      presets: [
        { id: "m1", label: "ok", providerId: "p1", model: "gpt" },
        { id: "m2", providerId: "p1" }, // malformed: missing label/model
      ],
      defaultPresetId: "m1",
      network: { roomId: "room-1" },
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    storage.setItem(LLM_CONFIG_KEY, JSON.stringify(raw));
    vi.stubGlobal("localStorage", storage);

    const config = loadLlmConfig();
    expect(config).not.toBeNull();
    expect(config?.providers).toEqual([{ id: "p1", label: "ok", baseUrl: "https://a", apiKey: "" }]);
    expect(config?.presets).toEqual([{ id: "m1", label: "ok", providerId: "p1", model: "gpt" }]);
    expect(config?.defaultPresetId).toBe("m1");
    expect(config?.network.roomId).toBe("room-1");
  });

  it("saveLlmConfig stamps updatedAt and persists valid JSON that loadLlmConfig reads back", () => {
    const storage = makeFakeStorage();
    vi.stubGlobal("localStorage", storage);

    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });
    ensurePreset(config, { providerId, model: "gpt-4o" });
    config.defaultPresetId = config.presets[0].id;

    expect(config.updatedAt).toBe("");
    saveLlmConfig(config);
    expect(config.updatedAt).not.toBe("");

    const reloaded = loadLlmConfig();
    expect(reloaded).toEqual(config);
  });

  it("saveLlmConfig never throws when localStorage.setItem throws", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => saveLlmConfig(emptyLlmConfig())).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("subscribeLlmConfig", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("invokes the callback with the freshly loaded config when the matching key changes", () => {
    const storage = makeFakeStorage();
    vi.stubGlobal("localStorage", storage);
    const fakeWindow = makeFakeWindow();
    vi.stubGlobal("window", fakeWindow);

    const config = emptyLlmConfig();
    config.network.roomId = "room-42";
    storage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));

    const cb = vi.fn();
    const unsubscribe = subscribeLlmConfig(cb);

    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: LLM_CONFIG_KEY }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]?.network.roomId).toBe("room-42");

    unsubscribe();
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: LLM_CONFIG_KEY }));
    expect(cb).toHaveBeenCalledTimes(1); // not called again after unsubscribe
  });

  it("ignores storage events for unrelated keys", () => {
    vi.stubGlobal("localStorage", makeFakeStorage());
    const fakeWindow = makeFakeWindow();
    vi.stubGlobal("window", fakeWindow);

    const cb = vi.fn();
    subscribeLlmConfig(cb);
    fakeWindow.dispatchEvent(Object.assign(new Event("storage"), { key: "some-other-key" }));
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("normalizeBaseUrl", () => {
  it("trims whitespace and strips trailing slashes", () => {
    expect(normalizeBaseUrl("  https://api.example.com/v1/  ")).toBe("https://api.example.com/v1");
    expect(normalizeBaseUrl("https://api.example.com///")).toBe("https://api.example.com");
  });
});

describe("ensureProvider / ensurePreset (append-only, dedup)", () => {
  it("ensureProvider creates a provider on first call and dedups by (baseUrl, apiKey) afterwards", () => {
    const config = emptyLlmConfig();
    const id1 = ensureProvider(config, { baseUrl: "https://api.example.com/v1/", apiKey: "sk-1" });
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].baseUrl).toBe("https://api.example.com/v1"); // normalized

    const id2 = ensureProvider(config, { baseUrl: "https://api.example.com/v1", apiKey: "sk-1" });
    expect(id2).toBe(id1);
    expect(config.providers).toHaveLength(1);

    // Different apiKey -> a distinct provider.
    const id3 = ensureProvider(config, { baseUrl: "https://api.example.com/v1", apiKey: "sk-2" });
    expect(id3).not.toBe(id1);
    expect(config.providers).toHaveLength(2);
  });

  it("ensurePreset dedups by (providerId, model, temperature, reasoningEffort) and never overwrites an explicit id", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://api.example.com", apiKey: "" });

    const id1 = ensurePreset(config, { providerId, model: "gpt-4o" });
    const id2 = ensurePreset(config, { providerId, model: "gpt-4o" });
    expect(id2).toBe(id1);
    expect(config.presets).toHaveLength(1);

    // Different temperature -> distinct preset.
    const id3 = ensurePreset(config, { providerId, model: "gpt-4o", temperature: 0.5 });
    expect(id3).not.toBe(id1);
    expect(config.presets).toHaveLength(2);

    // Explicit id that already exists is returned unchanged, no new entry.
    const id4 = ensurePreset(config, { id: id1, providerId, model: "some-other-model" });
    expect(id4).toBe(id1);
    expect(config.presets).toHaveLength(2);
    expect(config.presets.find((p) => p.id === id1)?.model).toBe("gpt-4o"); // untouched
  });
});

describe("resolvePreset", () => {
  it("resolves an explicit presetId, merging provider connection info", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://api.example.com", apiKey: "sk-1" });
    const presetId = ensurePreset(config, { providerId, model: "gpt-4o", temperature: 0.3, reasoningEffort: "low" });

    const resolved = resolvePreset(config, presetId);
    expect(resolved).toEqual({
      presetId,
      providerId,
      label: "gpt-4o",
      baseUrl: "https://api.example.com",
      apiKey: "sk-1",
      model: "gpt-4o",
      temperature: 0.3,
      reasoningEffort: "low",
    });
  });

  it("falls back to defaultPresetId when presetId is omitted or not found", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://api.example.com", apiKey: "" });
    const presetId = ensurePreset(config, { providerId, model: "gpt-4o" });
    config.defaultPresetId = presetId;

    expect(resolvePreset(config)?.presetId).toBe(presetId);
    expect(resolvePreset(config, "does-not-exist")?.presetId).toBe(presetId);
    expect(resolvePreset(config, null)?.presetId).toBe(presetId);
  });

  it("returns null when no preset can be found, or its provider no longer exists", () => {
    const config = emptyLlmConfig();
    expect(resolvePreset(config)).toBeNull();

    const providerId = ensureProvider(config, { baseUrl: "https://api.example.com", apiKey: "" });
    const presetId = ensurePreset(config, { providerId, model: "gpt-4o" });
    config.providers = []; // dangling providerId
    expect(resolvePreset(config, presetId)).toBeNull();
  });
});

describe("resolveVoice", () => {
  it("returns null when tts/stt is absent or has no model", () => {
    const config = emptyLlmConfig();
    expect(resolveVoice(config, "tts")).toBeNull();
    config.tts = { model: "" };
    expect(resolveVoice(config, "tts")).toBeNull();
  });

  it("resolves an explicit providerId", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://tts.example.com", apiKey: "sk-tts" });
    config.tts = { providerId, model: "tts-1", voice: "alloy" };

    expect(resolveVoice(config, "tts")).toEqual({
      baseUrl: "https://tts.example.com",
      apiKey: "sk-tts",
      model: "tts-1",
      voice: "alloy",
    });
  });

  it("falls back to the default preset's provider when providerId is omitted", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: "https://default.example.com", apiKey: "sk-def" });
    const presetId = ensurePreset(config, { providerId, model: "gpt-4o" });
    config.defaultPresetId = presetId;
    config.stt = { model: "whisper-1" };

    expect(resolveVoice(config, "stt")).toEqual({
      baseUrl: "https://default.example.com",
      apiKey: "sk-def",
      model: "whisper-1",
    });
  });

  it("returns null when the resolved provider can't be found", () => {
    const config = emptyLlmConfig();
    config.tts = { providerId: "dangling", model: "tts-1" };
    expect(resolveVoice(config, "tts")).toBeNull();
  });
});

describe("Settings-UI CRUD helpers", () => {
  function baseConfig(): SharedLlmConfigV1 {
    return emptyLlmConfig();
  }

  it("createProvider adds a blank provider; patchProvider updates fields; deleteProvider removes it", () => {
    const config = baseConfig();
    const id = createProvider(config, "My connection");
    expect(config.providers).toEqual([{ id, label: "My connection", baseUrl: "", apiKey: "" }]);

    patchProvider(config, id, { baseUrl: "https://api.example.com", apiKey: "sk-1" });
    expect(config.providers[0].baseUrl).toBe("https://api.example.com");

    deleteProvider(config, id);
    expect(config.providers).toEqual([]);
  });

  it("createPreset auto-assigns the first preset as default; deletePreset re-points defaultPresetId to the next remaining preset", () => {
    const config = baseConfig();
    const providerId = createProvider(config, "conn");

    const preset1 = createPreset(config, providerId, "Preset 1");
    expect(config.defaultPresetId).toBe(preset1);

    const preset2 = createPreset(config, providerId, "Preset 2");
    expect(config.defaultPresetId).toBe(preset1); // unchanged - only the FIRST ever preset auto-defaults

    deletePreset(config, preset1);
    expect(config.presets.map((p) => p.id)).toEqual([preset2]);
    expect(config.defaultPresetId).toBe(preset2); // re-pointed

    deletePreset(config, preset2);
    expect(config.presets).toEqual([]);
    expect(config.defaultPresetId).toBe("");
  });

  it("patchPreset updates fields in place", () => {
    const config = baseConfig();
    const providerId = createProvider(config, "conn");
    const presetId = createPreset(config, providerId, "Preset");
    patchPreset(config, presetId, { model: "gpt-4o", temperature: 0.2 });
    expect(config.presets[0]).toMatchObject({ model: "gpt-4o", temperature: 0.2 });
  });

  it("setVoiceConfig clears providerId when omitted and omits voice when blank", () => {
    const config = baseConfig();
    setVoiceConfig(config, "tts", { providerId: "p1", model: "tts-1", voice: "alloy" });
    expect(config.tts).toEqual({ providerId: "p1", model: "tts-1", voice: "alloy" });

    setVoiceConfig(config, "tts", { model: "" });
    expect(config.tts).toEqual({ model: "" });
  });

  it("setVoiceConfig preserves an existing speed set by another app instead of dropping it", () => {
    const config = baseConfig();
    // Simulates another app having set config.tts.speed independently — this
    // library's own voice-row UI never writes `speed` at all.
    config.tts = { model: "tts-1", speed: 1.25 };

    setVoiceConfig(config, "tts", { model: "tts-1", voice: "alloy" });
    expect(config.tts).toEqual({ model: "tts-1", voice: "alloy", speed: 1.25 });

    // Switching providerId/model/voice again still keeps speed.
    setVoiceConfig(config, "tts", { providerId: "p1", model: "tts-2" });
    expect(config.tts).toEqual({ providerId: "p1", model: "tts-2", speed: 1.25 });
  });

  it("setVoiceConfig does not invent a speed field when none existed before", () => {
    const config = baseConfig();
    setVoiceConfig(config, "stt", { model: "whisper-1" });
    expect(config.stt).toEqual({ model: "whisper-1" });
    expect("speed" in (config.stt as object)).toBe(false);
  });
});

describe("mist-network:// pseudo-provider conventions", () => {
  it("networkProviderBaseUrl builds a mist-network:// URL, defaulting the room to 'default'", () => {
    expect(networkProviderBaseUrl("my-room")).toBe(`${NETWORK_PROVIDER_URL_PREFIX}my-room`);
    expect(networkProviderBaseUrl("  ")).toBe(`${NETWORK_PROVIDER_URL_PREFIX}default`);
  });

  it("isNetworkProviderBaseUrl recognizes the prefix regardless of surrounding whitespace", () => {
    expect(isNetworkProviderBaseUrl("mist-network://room-1")).toBe(true);
    expect(isNetworkProviderBaseUrl("  mist-network://room-1")).toBe(true);
    expect(isNetworkProviderBaseUrl("https://api.example.com")).toBe(false);
  });

  it("advertisedModelName prefers the label, falling back to the model id", () => {
    expect(advertisedModelName({ label: "My GPT", model: "gpt-4o" })).toBe("My GPT");
    expect(advertisedModelName({ label: "  ", model: "gpt-4o" })).toBe("gpt-4o");
  });

  it("networkVoiceModelParam omits the auto sentinel and blank values, passes everything else through", () => {
    expect(networkVoiceModelParam(NETWORK_VOICE_AUTO_MODEL)).toBeUndefined();
    expect(networkVoiceModelParam("   ")).toBeUndefined();
    expect(networkVoiceModelParam("tts-1")).toBe("tts-1");
  });
});

describe("consolidateNetworkMirror", () => {
  it("is a no-op when there is no duplicate for the room", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: networkProviderBaseUrl("room1"), apiKey: "" });
    ensurePreset(config, { providerId, model: "gpt-4" });

    const result = consolidateNetworkMirror(config, "room1");

    expect(result.changed).toBe(false);
    expect(result.presetIdRemap.size).toBe(0);
    expect(config.providers).toHaveLength(1);
    expect(config.presets).toHaveLength(1);
  });

  it("merges duplicate pseudo-provider rows for the same room (e.g. a cross-instance write race) into the first one, repointing presets and defaultPresetId", () => {
    const config: SharedLlmConfigV1 = {
      v: 1,
      providers: [
        { id: "p1", label: "AI Network", baseUrl: "mist-network://room1", apiKey: "" },
        { id: "p2", label: "AI Network", baseUrl: "mist-network://room1", apiKey: "" },
      ],
      presets: [
        { id: "pr1", label: "gpt-4", providerId: "p1", model: "gpt-4" },
        { id: "pr2", label: "gpt-4", providerId: "p2", model: "gpt-4" }, // duplicate of pr1 under the other row
        { id: "pr3", label: "claude", providerId: "p2", model: "claude" }, // unique - should be adopted, keep its own id
      ],
      defaultPresetId: "pr2", // was pointing at the row that's about to be removed
      network: { roomId: "room1" },
      updatedAt: "",
    };

    const result = consolidateNetworkMirror(config, "room1");

    expect(result.changed).toBe(true);
    expect(config.providers.map((p) => p.id)).toEqual(["p1"]);
    expect(config.presets).toHaveLength(2);
    expect(config.presets.every((p) => p.providerId === "p1")).toBe(true);
    expect(result.presetIdRemap.get("pr2")).toBe("pr1");
    expect(config.defaultPresetId).toBe("pr1");
    expect(config.presets.some((p) => p.id === "pr3" && p.model === "claude")).toBe(true);
  });

  it("merges duplicate presets under a single provider row (e.g. a model re-advertised with incidental whitespace drift)", () => {
    const config = emptyLlmConfig();
    const providerId = ensureProvider(config, { baseUrl: networkProviderBaseUrl("room1"), apiKey: "" });
    const survivorId = ensurePreset(config, { providerId, model: "gpt-4" });
    // Bypass ensurePreset's own exact-match dedup to simulate a duplicate
    // that already exists in storage (from before this consolidation
    // existed, or from a raced write) with a whitespace-only difference.
    config.presets.push({ id: "dup", label: "gpt-4", providerId, model: "gpt-4 " });

    const result = consolidateNetworkMirror(config, "room1");

    expect(result.changed).toBe(true);
    expect(config.presets).toHaveLength(1);
    expect(config.presets[0].id).toBe(survivorId);
    expect(result.presetIdRemap.get("dup")).toBe(survivorId);
  });

  it("never touches a different room's pseudo-provider, or a real HTTP provider that happens to share a model name", () => {
    const config: SharedLlmConfigV1 = {
      v: 1,
      providers: [
        { id: "p1", label: "AI Network", baseUrl: "mist-network://room1", apiKey: "" },
        { id: "p2", label: "AI Network", baseUrl: "mist-network://room2", apiKey: "" },
        { id: "p3", label: "AI Network", baseUrl: "mist-network://room2", apiKey: "" }, // duplicate, but for room2
        { id: "http1", label: "My OpenAI", baseUrl: "https://api.example.com/v1", apiKey: "sk-xxx" },
      ],
      presets: [
        { id: "pr1", label: "gpt-4", providerId: "p1", model: "gpt-4" },
        { id: "pr2", label: "gpt-4", providerId: "http1", model: "gpt-4" }, // same model name, real provider - untouched
      ],
      defaultPresetId: "pr1",
      network: { roomId: "room1" },
      updatedAt: "",
    };

    const result = consolidateNetworkMirror(config, "room1");

    expect(result.changed).toBe(false);
    expect(config.providers).toHaveLength(4);
    expect(config.presets).toHaveLength(2);
  });
});

// Exercises the pure, exported TTS-voice-row logic from ../preact/settings.tsx
// (resolveVoiceEngine / shouldShowTtsVoiceRow / resolveTtsVoiceOptions /
// buildTtsVoiceOptionValues) per tts-voice-selection-v1 §2.4.
//
// This package has no jsdom/happy-dom dependency (see
// preact-network-provider.test.ts's own comment on the hand-rolled
// renderHook it uses instead), so rendering LlmTasksPanel's actual <select>
// DOM and reading it back isn't available here. The component's
// visibility/sourcing decisions were factored out into these standalone
// functions specifically so they're testable without a DOM — LlmTasksPanel
// calls the exact same functions, so this exercises the real logic, not a
// parallel reimplementation of it.

import { describe, expect, it } from "vitest";
import {
  buildTtsVoiceOptionValues,
  resolveTtsVoiceOptions,
  resolveVoiceEngine,
  shouldShowTtsVoiceRow,
} from "../preact/settings.js";
import {
  createPreset,
  createProvider,
  emptyLlmConfig,
  networkProviderBaseUrl,
  NETWORK_VOICE_AUTO_MODEL,
  patchPreset,
  patchProvider,
  type SharedLlmConfigV1,
} from "../llm-config.js";
import type { ConsumerStatus } from "../client.js";
import { OPENAI_TTS_VOICES } from "../openai.js";

function configWithHttpProvider(): { config: SharedLlmConfigV1; providerId: string } {
  const config = emptyLlmConfig();
  const providerId = createProvider(config, "My Server");
  patchProvider(config, providerId, { baseUrl: "https://api.example.com/v1", apiKey: "sk-test" });
  const presetId = createPreset(config, providerId, "Default");
  patchPreset(config, presetId, { model: "gpt-4o" });
  config.defaultPresetId = presetId;
  return { config, providerId };
}

function configWithNetworkProvider(): { config: SharedLlmConfigV1; providerId: string } {
  const config = emptyLlmConfig();
  const providerId = createProvider(config, "AI Network");
  patchProvider(config, providerId, { baseUrl: networkProviderBaseUrl("room1") });
  return { config, providerId };
}

describe("resolveVoiceEngine", () => {
  it("resolves 'browser' when no model is set at all (cfg undefined), independent of what provider the default preset resolves to", () => {
    const { config } = configWithHttpProvider();
    expect(resolveVoiceEngine(config, undefined).engine).toBe("browser");
  });

  it("resolves 'browser' with no provider info at all when there's no default preset to fall back to either", () => {
    const config = emptyLlmConfig();
    expect(resolveVoiceEngine(config, undefined)).toEqual({ baseUrl: "", apiKey: "", engine: "browser" });
  });

  it("resolves 'browser' when cfg.model is blank", () => {
    const { config } = configWithHttpProvider();
    expect(resolveVoiceEngine(config, { model: "" }).engine).toBe("browser");
  });

  it("resolves 'api' for a model pointed at a regular HTTP provider", () => {
    const { config, providerId } = configWithHttpProvider();
    const result = resolveVoiceEngine(config, { providerId, model: "tts-1" });
    expect(result).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", engine: "api" });
  });

  it("resolves 'network' for a model pointed at the mist-network:// pseudo-provider", () => {
    const { config, providerId } = configWithNetworkProvider();
    const result = resolveVoiceEngine(config, { providerId, model: "some-advertised-preset" });
    expect(result.engine).toBe("network");
  });

  it("resolves 'network' for the network-auto sentinel model too", () => {
    const { config, providerId } = configWithNetworkProvider();
    const result = resolveVoiceEngine(config, { providerId, model: NETWORK_VOICE_AUTO_MODEL });
    expect(result.engine).toBe("network");
  });

  it("falls back to the default preset's provider when providerId is omitted", () => {
    const { config } = configWithHttpProvider();
    const result = resolveVoiceEngine(config, { model: "tts-1" });
    expect(result).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "sk-test", engine: "api" });
  });

  it("resolves an empty baseUrl (still 'api', not 'network') when the provider can't be found at all", () => {
    const config = emptyLlmConfig();
    const result = resolveVoiceEngine(config, { providerId: "dangling", model: "tts-1" });
    expect(result).toEqual({ baseUrl: "", apiKey: "", engine: "api" });
  });
});

describe("shouldShowTtsVoiceRow", () => {
  it("is false without a voice.tts adapter, regardless of engine", () => {
    expect(shouldShowTtsVoiceRow(false, "api")).toBe(false);
    expect(shouldShowTtsVoiceRow(false, "network")).toBe(false);
    expect(shouldShowTtsVoiceRow(false, "browser")).toBe(false);
  });

  it("is false for the browser engine even with an adapter present", () => {
    expect(shouldShowTtsVoiceRow(true, "browser")).toBe(false);
  });

  it("is true for the api engine with an adapter present", () => {
    expect(shouldShowTtsVoiceRow(true, "api")).toBe(true);
  });

  it("is true for the network engine (including network-auto) with an adapter present — the §2.4 change: no longer hidden for the auto sentinel", () => {
    expect(shouldShowTtsVoiceRow(true, "network")).toBe(true);
  });
});

describe("resolveTtsVoiceOptions", () => {
  const connectedStatus = (voices?: string[]): ConsumerStatus => ({
    phase: "connected",
    providerId: "prov1",
    providers: [{ id: "prov1", services: ["tts"], voices }],
    ...(voices !== undefined ? { voices } : {}),
  });

  it("network: sources choices from consumerStatus.voices", () => {
    const options = resolveTtsVoiceOptions({
      engine: "network",
      consumerStatus: connectedStatus(["alloy", "coral"]),
      fetchedApiVoices: [],
    });
    expect(options).toEqual(["alloy", "coral"]);
  });

  it("network: is empty (not OPENAI_TTS_VOICES) when the room advertised no voices at all", () => {
    const options = resolveTtsVoiceOptions({
      engine: "network",
      consumerStatus: connectedStatus(undefined),
      fetchedApiVoices: [],
      adapterVoiceOptions: ["should-not-appear"],
    });
    expect(options).toEqual([]);
  });

  it("network: is empty when not connected at all", () => {
    const options = resolveTtsVoiceOptions({
      engine: "network",
      consumerStatus: { phase: "searching" },
      fetchedApiVoices: [],
    });
    expect(options).toEqual([]);
  });

  it("network: is empty when consumerStatus is omitted entirely", () => {
    expect(resolveTtsVoiceOptions({ engine: "network", fetchedApiVoices: [] })).toEqual([]);
  });

  it("api: prefers a non-empty fetched list over the adapter list and the static fallback", () => {
    const options = resolveTtsVoiceOptions({
      engine: "api",
      fetchedApiVoices: ["kokoro-1", "kokoro-2"],
      adapterVoiceOptions: ["adapter-voice"],
    });
    expect(options).toEqual(["kokoro-1", "kokoro-2"]);
  });

  it("api: falls back to the adapter-supplied list when the fetch came back empty", () => {
    const options = resolveTtsVoiceOptions({
      engine: "api",
      fetchedApiVoices: [],
      adapterVoiceOptions: ["adapter-voice"],
    });
    expect(options).toEqual(["adapter-voice"]);
  });

  it("api: falls back to OPENAI_TTS_VOICES when both the fetch and the adapter list are empty", () => {
    const options = resolveTtsVoiceOptions({ engine: "api", fetchedApiVoices: [] });
    expect(options).toEqual(OPENAI_TTS_VOICES);
  });

  it("browser: always empty", () => {
    expect(
      resolveTtsVoiceOptions({ engine: "browser", fetchedApiVoices: ["x"], adapterVoiceOptions: ["y"] }),
    ).toEqual([]);
  });
});

describe("buildTtsVoiceOptionValues", () => {
  it("always starts with the '' provider-default sentinel", () => {
    expect(buildTtsVoiceOptionValues([], "")[0]).toBe("");
    expect(buildTtsVoiceOptionValues(["alloy"], "alloy")[0]).toBe("");
  });

  it("appends the current voice as an extra option when it isn't in the offered list", () => {
    expect(buildTtsVoiceOptionValues(["alloy", "coral"], "stale-voice")).toEqual([
      "",
      "stale-voice",
      "alloy",
      "coral",
    ]);
  });

  it("does not duplicate the current voice when it's already in the offered list", () => {
    expect(buildTtsVoiceOptionValues(["alloy", "coral"], "alloy")).toEqual(["", "alloy", "coral"]);
  });

  it("adds no extra entry when there is no current voice (provider default selected)", () => {
    expect(buildTtsVoiceOptionValues(["alloy", "coral"], "")).toEqual(["", "alloy", "coral"]);
  });
});

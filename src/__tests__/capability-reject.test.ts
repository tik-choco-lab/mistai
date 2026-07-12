// Capability-mismatch behavior added on top of the base provider/voice-provider
// services: provider_hello.services advertisement and immediate rejection of
// requests for services this provider doesn't offer at all.
//
// Covers rejectVoiceRequest (voice-provider.ts), the VoiceProviderService
// internal fallback for a partially-configured service (e.g. synthesize but
// no transcribe), and the preact hook's pure routing/hello helpers
// (deriveHelloServices / routeProviderRequest), which is unit-testable
// without rendering the hook.

import { describe, expect, it, vi } from "vitest";
import { rejectVoiceRequest, VoiceProviderService } from "../voice-provider.js";
import { ERROR_CODE_UNSUPPORTED_SERVICE } from "../protocol.js";
import type { ProtocolMessage } from "../protocol.js";
import { MistaiError } from "../errors.js";
import { ProviderService } from "../provider.js";
import {
  deriveHelloServices,
  routeProviderRequest,
  type ProviderRequestRouterDeps,
} from "../preact/index.js";

describe("rejectVoiceRequest", () => {
  it("sends a code-carrying voice_error for an unsupported tts_request", () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });

    rejectVoiceRequest(send, "peerA", "t1", "tts");

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "voice_error",
          id: "t1",
          message: "this provider does not support tts",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });

  it("sends a code-carrying voice_error for an unsupported stt_request", () => {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });

    rejectVoiceRequest(send, "peerA", "s1", "stt");

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "voice_error",
          id: "s1",
          message: "this provider does not support stt",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });
});

describe("VoiceProviderService partial-capability fallback", () => {
  it("emits a code-carrying voice_error (not a generic one) when synthesize throws ENDPOINT_NOT_CONFIGURED", async () => {
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => {
        throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no TTS endpoint configured.");
      },
      async () => "unused",
    );

    await provider.handleMessage("c1", { v: 1, type: "tts_request", id: "t1", text: "hi" });

    expect(sent).toEqual([
      {
        v: 1,
        type: "voice_error",
        id: "t1",
        message: "this provider does not support tts",
        code: ERROR_CODE_UNSUPPORTED_SERVICE,
      },
    ]);
  });

  it("emits a code-carrying voice_error when transcribe throws ENDPOINT_NOT_CONFIGURED (synthesize configured, transcribe not)", async () => {
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => ({ blob: new Blob([]), mime: "audio/mpeg" }),
      async () => {
        throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no STT endpoint configured.");
      },
    );

    await provider.handleMessage("c1", {
      v: 1,
      type: "stt_request",
      id: "s1",
      seq: 0,
      data: "QUJD",
      last: true,
      mime: "audio/webm",
    });

    expect(sent).toEqual([
      {
        v: 1,
        type: "voice_error",
        id: "s1",
        message: "this provider does not support stt",
        code: ERROR_CODE_UNSUPPORTED_SERVICE,
      },
    ]);
  });

  it("still sends a plain (uncoded) voice_error for a genuine upstream failure", async () => {
    const sent: ProtocolMessage[] = [];
    const provider = new VoiceProviderService(
      (_toId, msg) => sent.push(msg),
      async () => {
        throw new Error("tts upstream down");
      },
      async () => "unused",
    );

    await provider.handleMessage("c1", { v: 1, type: "tts_request", id: "t1", text: "hi" });

    expect(sent).toEqual([{ v: 1, type: "voice_error", id: "t1", message: "tts upstream down" }]);
  });
});

describe("deriveHelloServices", () => {
  it("returns all three when chat, tts and stt handlers are all injected", () => {
    expect(
      deriveHelloServices({ callLlm: vi.fn() as never, synthesize: vi.fn() as never, transcribe: vi.fn() as never }),
    ).toEqual(["chat", "tts", "stt"]);
  });

  it("returns only chat when just callLlm is injected", () => {
    expect(deriveHelloServices({ callLlm: vi.fn() as never })).toEqual(["chat"]);
  });

  it("returns only tts+stt when just voice handlers are injected", () => {
    expect(deriveHelloServices({ synthesize: vi.fn() as never, transcribe: vi.fn() as never })).toEqual([
      "tts",
      "stt",
    ]);
  });

  it("returns an empty array when nothing is injected", () => {
    expect(deriveHelloServices({})).toEqual([]);
  });
});

describe("routeProviderRequest", () => {
  function makeDeps(overrides: Partial<ProviderRequestRouterDeps> = {}): {
    deps: ProviderRequestRouterDeps;
    sent: { toId: string; msg: ProtocolMessage }[];
  } {
    const sent: { toId: string; msg: ProtocolMessage }[] = [];
    const send = (toId: string, msg: ProtocolMessage) => sent.push({ toId, msg });
    return {
      deps: { providerService: null, voiceProviderService: null, send, ...overrides },
      sent,
    };
  }

  it("forwards llm_request to providerService.handleMessage when configured", () => {
    const handleMessage = vi.fn();
    const providerService = { handleMessage } as unknown as ProviderService;
    const { deps } = makeDeps({ providerService });
    const msg: ProtocolMessage = { v: 1, type: "llm_request", id: "r1", messages: [{ role: "user", content: "hi" }] };

    routeProviderRequest("peerA", msg, deps);

    expect(handleMessage).toHaveBeenCalledWith("peerA", msg);
  });

  it("rejects llm_request with a code-carrying llm_error when no providerService is configured", () => {
    const { deps, sent } = makeDeps();
    const msg: ProtocolMessage = { v: 1, type: "llm_request", id: "r1", messages: [{ role: "user", content: "hi" }] };

    routeProviderRequest("peerA", msg, deps);

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "llm_error",
          id: "r1",
          message: "this provider does not support chat",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });

  it("forwards tts_request to voiceProviderService.handleMessage when configured", () => {
    const handleMessage = vi.fn();
    const voiceProviderService = { handleMessage } as unknown as VoiceProviderService;
    const { deps } = makeDeps({ voiceProviderService });
    const msg: ProtocolMessage = { v: 1, type: "tts_request", id: "t1", text: "hi" };

    routeProviderRequest("peerA", msg, deps);

    expect(handleMessage).toHaveBeenCalledWith("peerA", msg);
  });

  it("rejects tts_request with a code-carrying voice_error when no voiceProviderService is configured", () => {
    const { deps, sent } = makeDeps();
    const msg: ProtocolMessage = { v: 1, type: "tts_request", id: "t1", text: "hi" };

    routeProviderRequest("peerA", msg, deps);

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "voice_error",
          id: "t1",
          message: "this provider does not support tts",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });

  it("rejects only the seq 0 stt_request chunk when no voiceProviderService is configured, and ignores later chunks", () => {
    const { deps, sent } = makeDeps();

    routeProviderRequest("peerA", { v: 1, type: "stt_request", id: "s1", seq: 0, data: "AAA", last: false, mime: "audio/webm" }, deps);
    routeProviderRequest("peerA", { v: 1, type: "stt_request", id: "s1", seq: 1, data: "BBB", last: false, mime: "audio/webm" }, deps);
    routeProviderRequest("peerA", { v: 1, type: "stt_request", id: "s1", seq: 2, data: "CCC", last: true, mime: "audio/webm" }, deps);

    expect(sent).toEqual([
      {
        toId: "peerA",
        msg: {
          v: 1,
          type: "voice_error",
          id: "s1",
          message: "this provider does not support stt",
          code: ERROR_CODE_UNSUPPORTED_SERVICE,
        },
      },
    ]);
  });

  it("does not touch send/services for unrelated message types", () => {
    const handleMessage = vi.fn();
    const providerService = { handleMessage } as unknown as ProviderService;
    const voiceProviderService = { handleMessage } as unknown as VoiceProviderService;
    const { deps, sent } = makeDeps({ providerService, voiceProviderService });

    routeProviderRequest("peerA", { v: 1, type: "consumer_hello" }, deps);
    routeProviderRequest("peerA", { v: 1, type: "raft_message", payload: "abc" }, deps);

    expect(handleMessage).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});

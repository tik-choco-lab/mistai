// Optional preact bindings: thin hooks over the transport-agnostic core.
// Import from "@tik-choco/mistai/preact"; requires the `preact` peer.
//
// Ported from tc-translate/src/hooks/useNetworkConsumerStatus.ts,
// useNetworkConsumerConnection.ts and useNetworkProvider.ts, decoupled from
// app settings.

export {
  ConsumerStatusIndicator,
  ConsumerStepIndicator,
  ProviderStatusPanel,
  consumerErrorText,
  type ConsumerStatusIndicatorProps,
  type ProviderStatusPanelProps,
  type ProviderPanelStatus,
  type ProviderPeerInfo,
} from "./ui.js";

// Shared 3-tab LLM settings UI (AI Connection / AI Network / Tasks) — apps
// supply task definitions + small adapters and get the family-common
// settings screens; the shared llm config itself is managed internally via
// "../llm-config.js".
export * from "./settings.js";

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ConsumerClient, type ConsumerStatus } from "../client.js";
import { Network, type MistNodeLike } from "../node.js";
import { ProviderService, rejectLlmRequest, type LlmCallFn, type ProviderLogEntry, type SendFn } from "../provider.js";
import { VoiceProviderService, rejectVoiceRequest, type SynthesizeFn, type TranscribeFn } from "../voice-provider.js";
import { OAI_TUNNEL_SERVICE, type ProtocolMessage, type ProviderHelloMsg } from "../protocol.js";
import { OaiTunnelProvider, type OaiUpstreamResolver } from "../tunnel.js";
import { MistaiError } from "../errors.js";

/** Tracks the consumer-side LLM Network connection lifecycle for display in the UI. */
export function useConsumerStatus(client: ConsumerClient): ConsumerStatus {
  const [status, setStatus] = useState<ConsumerStatus>(() => client.status);

  useEffect(() => {
    // Re-sync in case the status changed between render and subscription.
    setStatus(client.status);
    return client.onStatusChange(setStatus);
  }, [client]);

  return status;
}

export interface UseConsumerConnectionOptions {
  enabled: boolean;
  roomId: string;
  /** Debounce before connecting, so typing a Room ID doesn't thrash the connection. Defaults to 500ms. */
  debounceMs?: number;
}

/**
 * Eagerly (re)connects the LLM Network consumer session whenever consumer mode
 * is enabled and a Room ID is present, instead of waiting for the first
 * request to lazily join. Reconnects when the Room ID changes and disconnects
 * when disabled.
 */
export function useConsumerConnection(client: ConsumerClient, options: UseConsumerConnectionOptions): void {
  const { enabled, debounceMs = 500 } = options;
  const roomId = options.roomId.trim();

  useEffect(() => {
    if (!enabled || !roomId) {
      client.disconnect();
      return;
    }

    // Debounce so a connection attempt isn't fired on every keystroke while
    // the user is still typing the Room ID.
    const timer = setTimeout(() => {
      void client.connect(roomId);
    }, debounceMs);

    return () => {
      clearTimeout(timer);
      // Intentionally not disconnecting here: the session is keyed by roomId
      // inside ConsumerClient and reconnecting on every unrelated render
      // would thrash the connection. Disconnection happens explicitly above
      // when disabled, and connect() reuses/replaces the session when the
      // roomId changes.
    };
  }, [client, enabled, roomId, debounceMs]);
}

export type NetworkProviderStatus = "idle" | "connecting" | "connected" | "error";

export type NetworkProviderPeer = {
  nodeId: string;
  connectedAt: number;
  isConsumer: boolean;
};

export interface UseNetworkProviderOptions {
  enabled: boolean;
  roomId: string;
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  nodeIdStorageKey?: string;
  /** Upstream chat handler; llm_request is rejected with a code:"unsupported_service" llm_error when omitted. */
  callLlm?: LlmCallFn;
  /** Upstream TTS handler; tts_request is rejected with a code:"unsupported_service" voice_error when omitted. */
  synthesize?: SynthesizeFn;
  /** Upstream STT handler; stt_request is rejected with a code:"unsupported_service" voice_error when omitted. */
  transcribe?: TranscribeFn;
  /** Model ids advertised via provider_hello.models. */
  advertisedModels?: string[];
  /**
   * TTS voice names advertised via provider_hello.voices (see
   * ../protocol.js). Meaningful only when `services` ends up including
   * `"tts"` (i.e. `synthesize` is provided); harmless to pass otherwise since
   * a consumer only reads it off a `"tts"`-advertising provider. Like
   * `advertisedModels`, changes here are re-broadcast to the room on a live
   * session (see the `helloKey` effect below).
   */
  advertisedVoices?: string[];
  /** Max retained request-log entries. Defaults to 50. */
  maxLogEntries?: number;
  /**
   * Extra service names appended to provider_hello.services alongside the
   * ones derived from callLlm/synthesize/transcribe (e.g. an app-defined
   * capability marker). `'oai'` is added automatically when
   * `resolveOaiUpstream` is provided — no need to list it here too.
   */
  extraServices?: string[];
  /**
   * When provided, this provider also tunnels OpenAI-compatible HTTP
   * requests (oai_request/oai_response/oai_error — see ../tunnel.js):
   * `'oai'` is added to the advertised services automatically, and an
   * `OaiTunnelProvider` wired to `resolveOaiUpstream` is consulted first on
   * every incoming message. See `OaiUpstreamResolver` for the allowlist/
   * rejection contract (throwing or returning null rejects the request
   * instead of forwarding it upstream).
   */
  resolveOaiUpstream?: OaiUpstreamResolver;
}

export interface UseNetworkProviderResult {
  status: NetworkProviderStatus;
  statusUpdatedAt: number;
  errorMessage: string | null;
  peers: NetworkProviderPeer[];
  peerCount: number;
  consumerCount: number;
  logs: ProviderLogEntry[];
  ownNodeId: string | null;
  roomId: string;
}

/**
 * Derives the `provider_hello.services` list from which upstream functions
 * are actually injected: "chat" for callLlm, "tts" for synthesize, "stt" for
 * transcribe. Always returns an array (possibly empty) — services is meant to
 * be advertised explicitly, not omitted, so consumers never fall back to the
 * legacy chat-only default (`DEFAULT_PROVIDER_SERVICES`) for a hello that
 * actually came from this hook. Exported as a pure helper so it's unit
 * testable without rendering the hook.
 */
export function deriveHelloServices(fns: {
  callLlm?: UseNetworkProviderOptions["callLlm"];
  synthesize?: UseNetworkProviderOptions["synthesize"];
  transcribe?: UseNetworkProviderOptions["transcribe"];
}): string[] {
  const services: string[] = [];
  if (fns.callLlm) services.push("chat");
  if (fns.synthesize) services.push("tts");
  if (fns.transcribe) services.push("stt");
  return services;
}

export interface ProviderRequestRouterDeps {
  providerService: ProviderService | null;
  voiceProviderService: VoiceProviderService | null;
  send: SendFn;
}

/**
 * Routes an incoming llm_request / tts_request / stt_request to the matching
 * service, or rejects it immediately with an `unsupported_service`-coded
 * error when this provider doesn't advertise that capability at all (the
 * matching service is `null`, i.e. the corresponding upstream function was
 * never injected). No-ops for every other message type.
 *
 * stt_request arrives as a seq-numbered chunk stream; when there's no
 * transcribe function at all we reject only the seq 0 chunk (which carries
 * the request's identity) and silently ignore the rest, rather than sending
 * one voice_error per chunk.
 *
 * Exported (not just used internally by useNetworkProvider) so a non-preact
 * host driving the wire protocol directly (e.g. tc-note) gets the same
 * capability-mismatch behavior for free.
 */
export function routeProviderRequest(fromId: string, msg: ProtocolMessage, deps: ProviderRequestRouterDeps): void {
  if (msg.type === "llm_request") {
    if (deps.providerService) {
      void deps.providerService.handleMessage(fromId, msg);
    } else {
      rejectLlmRequest(deps.send, fromId, msg.id);
    }
    return;
  }
  if (msg.type === "tts_request" || msg.type === "stt_request") {
    if (deps.voiceProviderService) {
      void deps.voiceProviderService.handleMessage(fromId, msg);
      return;
    }
    if (msg.type === "tts_request" || msg.seq === 0) {
      rejectVoiceRequest(deps.send, fromId, msg.id, msg.type === "tts_request" ? "tts" : "stt");
    }
  }
}

/**
 * Owns the "participate as an LLM Network provider" lifecycle: joins/leaves
 * the room, forwards llm_request / tts_request / stt_request traffic to the
 * injected upstream functions, and surfaces connection/peer/request-log state
 * for the UI.
 */
export function useNetworkProvider(options: UseNetworkProviderOptions): UseNetworkProviderResult {
  const [status, setStatus] = useState<NetworkProviderStatus>("idle");
  const [statusUpdatedAt, setStatusUpdatedAt] = useState(() => Date.now());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [peers, setPeers] = useState<NetworkProviderPeer[]>([]);
  const [logs, setLogs] = useState<ProviderLogEntry[]>([]);
  const [ownNodeId, setOwnNodeId] = useState<string | null>(null);

  const maxLogEntries = options.maxLogEntries ?? 50;

  function updateStatus(next: NetworkProviderStatus): void {
    setStatus((current) => {
      if (current !== next) setStatusUpdatedAt(Date.now());
      return next;
    });
  }

  // Everything but enabled/roomId rides in refs so upstream-function identity
  // changes don't tear down and rejoin the room on every render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const networkRef = useRef<Network | null>(null);
  const providerServiceRef = useRef<ProviderService | null>(null);
  const voiceProviderServiceRef = useRef<VoiceProviderService | null>(null);
  const tunnelProviderRef = useRef<OaiTunnelProvider | null>(null);

  const enabled = options.enabled;
  const roomId = options.roomId.trim();

  const consumerCount = useMemo(() => peers.filter((peer) => peer.isConsumer).length, [peers]);

  // Reads the latest options at send time, so the join broadcast, the
  // per-peer hellos, and the live re-broadcast effect below all advertise
  // the same, current capability set.
  function helloMessage(): ProviderHelloMsg {
    const opts = optionsRef.current;
    const services = [...deriveHelloServices(opts), ...(opts.extraServices ?? [])];
    if (opts.resolveOaiUpstream && !services.includes(OAI_TUNNEL_SERVICE)) services.push(OAI_TUNNEL_SERVICE);
    const models = opts.advertisedModels;
    const voices = opts.advertisedVoices;
    return {
      v: 1,
      type: "provider_hello",
      services,
      ...(models && models.length > 0 ? { models } : {}),
      ...(voices && voices.length > 0 ? { voices } : {}),
    };
  }

  useEffect(() => {
    if (!enabled || !roomId) {
      networkRef.current?.destroy();
      networkRef.current = null;
      providerServiceRef.current = null;
      voiceProviderServiceRef.current = null;
      tunnelProviderRef.current = null;
      updateStatus("idle");
      setErrorMessage(null);
      setPeers([]);
      return;
    }

    let cancelled = false;
    updateStatus("connecting");
    setErrorMessage(null);
    setPeers([]);
    setLogs([]);

    const cap = optionsRef.current.maxLogEntries ?? 50;
    const pushLog = (entry: ProviderLogEntry): void => {
      setLogs((current) => {
        const withoutEntry = current.filter((logEntry) => logEntry.id !== entry.id);
        return [entry, ...withoutEntry].slice(0, cap);
      });
    };

    const sendToNetwork: SendFn = (toId, msg) => network.send(toId, msg);

    const network = new Network({
      createNode: (nodeId) => optionsRef.current.createNode(nodeId),
      nodeIdStorageKey: optionsRef.current.nodeIdStorageKey,
      callbacks: {
        onPeerConnected: (peerId) => {
          setPeers((current) =>
            current.some((peer) => peer.nodeId === peerId)
              ? current
              : [...current, { nodeId: peerId, connectedAt: Date.now(), isConsumer: false }],
          );
          // A newly connected peer might be a consumer looking for us — announce ourselves.
          network.send(peerId, helloMessage());
        },
        onPeerDisconnected: (peerId) => {
          setPeers((current) => current.filter((peer) => peer.nodeId !== peerId));
          voiceProviderServiceRef.current?.dropPeer(peerId);
          tunnelProviderRef.current?.dropPeer(peerId);
        },
        onMessage: (fromId, msg) => {
          // oai_* tunnel messages (OpenAI-compatible HTTP-over-P2P) are fully
          // owned by the tunnel provider when one is configured; everything
          // else below is routed as usual. Consulting it first means a
          // provider that only sets resolveOaiUpstream never has to touch
          // routeProviderRequest at all.
          if (tunnelProviderRef.current?.handleMessage(fromId, msg)) return;
          if (msg.type === "consumer_hello") {
            setPeers((current) => {
              const existing = current.find((peer) => peer.nodeId === fromId);
              if (existing) {
                return current.map((peer) => (peer.nodeId === fromId ? { ...peer, isConsumer: true } : peer));
              }
              return [...current, { nodeId: fromId, connectedAt: Date.now(), isConsumer: true }];
            });
            network.send(fromId, helloMessage());
            return;
          }
          routeProviderRequest(fromId, msg, {
            providerService: providerServiceRef.current,
            voiceProviderService: voiceProviderServiceRef.current,
            send: sendToNetwork,
          });
        },
      },
    });

    const callLlm = optionsRef.current.callLlm;
    const providerService = callLlm
      ? new ProviderService(
          sendToNetwork,
          (messages, model, onDelta) => {
            const fn = optionsRef.current.callLlm;
            if (!fn) throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no LLM endpoint configured.");
            return fn(messages, model, onDelta);
          },
          { onRequestLog: pushLog, maxLogEntries: cap },
        )
      : null;

    const hasVoice = Boolean(optionsRef.current.synthesize || optionsRef.current.transcribe);
    const voiceProviderService = hasVoice
      ? new VoiceProviderService(
          sendToNetwork,
          async (text, model, voice) => {
            const fn = optionsRef.current.synthesize;
            if (!fn) throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no TTS endpoint configured.");
            return fn(text, model, voice);
          },
          async (audio, mime, model, fileName) => {
            const fn = optionsRef.current.transcribe;
            if (!fn) throw new MistaiError("ENDPOINT_NOT_CONFIGURED", "This provider has no STT endpoint configured.");
            return fn(audio, mime, model, fileName);
          },
          { onRequestLog: pushLog },
        )
      : null;

    const resolveOaiUpstream = optionsRef.current.resolveOaiUpstream;
    const tunnelProvider = resolveOaiUpstream ? new OaiTunnelProvider(sendToNetwork, resolveOaiUpstream) : null;

    networkRef.current = network;
    providerServiceRef.current = providerService;
    voiceProviderServiceRef.current = voiceProviderService;
    tunnelProviderRef.current = tunnelProvider;
    setOwnNodeId(network.id);

    network
      .join(roomId)
      .then(() => {
        if (cancelled) return;
        updateStatus("connected");
        // Announce presence to anyone already in the room.
        network.send(null, helloMessage());
      })
      .catch((err) => {
        if (cancelled) return;
        updateStatus("error");
        setErrorMessage(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      network.destroy();
      if (networkRef.current === network) networkRef.current = null;
      if (providerServiceRef.current === providerService) providerServiceRef.current = null;
      if (voiceProviderServiceRef.current === voiceProviderService) voiceProviderServiceRef.current = null;
      if (tunnelProviderRef.current === tunnelProvider) tunnelProviderRef.current = null;
    };
  }, [enabled, roomId]);

  // Re-broadcast provider_hello, without leaving the room, whenever what it
  // would announce (services + extraServices + oai + advertised models)
  // changes on a live session. The join effect above only sends hello on
  // join / peer-connect / consumer_hello, so a share-list edit made while
  // already connected would otherwise either never reach existing consumers,
  // or require a disruptive leave/rejoin (dropping in-flight requests) to
  // propagate. Consumers apply provider_hello updates mid-session (see
  // ConsumerClient's onMessage -> emitTableStatus), so the re-broadcast alone
  // is enough to close the loop. Joining/connecting sessions are skipped:
  // their own join broadcast reads the latest options from the ref anyway.
  const oaiService = options.resolveOaiUpstream ? OAI_TUNNEL_SERVICE : "";
  const helloKey = `${deriveHelloServices(options).join(",")}|${(options.extraServices ?? []).join(",")}|${oaiService}|${(options.advertisedModels ?? []).join("\n")}|${(options.advertisedVoices ?? []).join("\n")}`;
  const helloKeyRef = useRef(helloKey);
  useEffect(() => {
    if (helloKeyRef.current === helloKey) return;
    helloKeyRef.current = helloKey;
    if (status !== "connected") return;
    networkRef.current?.send(null, helloMessage());
  }, [helloKey, status]);

  return {
    status,
    statusUpdatedAt,
    errorMessage,
    peers,
    peerCount: peers.length,
    consumerCount,
    logs: logs.slice(0, maxLogEntries),
    ownNodeId,
    roomId,
  };
}

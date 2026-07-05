// Optional preact bindings: thin hooks over the transport-agnostic core.
// Import from "@tik-choco/mistai/preact"; requires the `preact` peer.
//
// Ported from tc-translate/src/hooks/useNetworkConsumerStatus.ts,
// useNetworkConsumerConnection.ts and useNetworkProvider.ts, decoupled from
// app settings.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ConsumerClient, type ConsumerStatus } from "../client.js";
import { Network, type MistNodeLike } from "../node.js";
import { ProviderService, type LlmCallFn, type ProviderLogEntry } from "../provider.js";
import { VoiceProviderService, type SynthesizeFn, type TranscribeFn } from "../voice-provider.js";
import type { ProviderHelloMsg } from "../protocol.js";
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
  /** Upstream chat handler; llm_request traffic is ignored when omitted. */
  callLlm?: LlmCallFn;
  /** Upstream TTS handler; tts_request fails with voice_error when omitted. */
  synthesize?: SynthesizeFn;
  /** Upstream STT handler; stt_request fails with voice_error when omitted. */
  transcribe?: TranscribeFn;
  /** Model ids advertised via provider_hello.models. */
  advertisedModels?: string[];
  /** Max retained request-log entries. Defaults to 50. */
  maxLogEntries?: number;
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

  const enabled = options.enabled;
  const roomId = options.roomId.trim();

  const consumerCount = useMemo(() => peers.filter((peer) => peer.isConsumer).length, [peers]);

  useEffect(() => {
    if (!enabled || !roomId) {
      networkRef.current?.destroy();
      networkRef.current = null;
      providerServiceRef.current = null;
      voiceProviderServiceRef.current = null;
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

    const helloMessage = (): ProviderHelloMsg => {
      const models = optionsRef.current.advertisedModels;
      return models && models.length > 0
        ? { v: 1, type: "provider_hello", models }
        : { v: 1, type: "provider_hello" };
    };

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
        },
        onMessage: (fromId, msg) => {
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
          if (msg.type === "tts_request" || msg.type === "stt_request") {
            void voiceProviderServiceRef.current?.handleMessage(fromId, msg);
            return;
          }
          void providerServiceRef.current?.handleMessage(fromId, msg);
        },
      },
    });

    const callLlm = optionsRef.current.callLlm;
    const providerService = callLlm
      ? new ProviderService(
          (toId, msg) => network.send(toId, msg),
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
          (toId, msg) => network.send(toId, msg),
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

    networkRef.current = network;
    providerServiceRef.current = providerService;
    voiceProviderServiceRef.current = voiceProviderService;
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
    };
  }, [enabled, roomId]);

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

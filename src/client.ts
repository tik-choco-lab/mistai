// Consumer-facing entry point for LLM Network requests. Lazily joins the
// configured mist room on first use and sends requests to the first provider
// that announces itself via provider_hello. The session is reused across
// requests as long as the room id doesn't change.
//
// Reworked from tc-translate/src/lib/mistllm/client.ts (a module singleton)
// into an instantiable class; apps may still keep a module singleton
// themselves. Improvements over the reference: consumer_hello is broadcast
// after joining and sent to the provider on provider_hello (so providers can
// label consumers), and provider_hello.models is captured into the status.

import { Network, type MistNodeLike } from "./node.js";
import { MistaiError, type MistaiErrorCode } from "./errors.js";
import { ConsumerService } from "./consumer.js";
import { VoiceConsumerService } from "./voice-consumer.js";
import type { ChatMessage } from "./protocol.js";

const DEFAULT_PROVIDER_WAIT_TIMEOUT_MS = 10_000;
const PROVIDER_NOT_FOUND_MESSAGE = "No provider found on the LLM Network.";
const NO_ROOM_ID_MESSAGE = "LLM Network room ID is not set.";
const PROVIDER_DISCONNECTED_MESSAGE = "Connection to the provider was lost.";

/**
 * Consumer-side connection state, surfaced to the UI so it can show more than
 * just idle/connected. Mirrors the lifecycle: join the room, wait for a
 * provider_hello, then hold the providerId once one arrives.
 */
export type ConsumerStatus =
  | { phase: "idle" }
  | { phase: "joining" }
  | { phase: "searching" }
  | { phase: "connected"; providerId: string; models?: string[] }
  | { phase: "error"; message: string; code?: MistaiErrorCode };

export type ConsumerStatusListener = (status: ConsumerStatus) => void;

export interface ConsumerClientOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  /** localStorage key for the persistent node id. Defaults to "mistai:node-id". */
  nodeIdStorageKey?: string;
  /** How long to wait for a provider_hello before failing a request. Defaults to 10s. */
  providerWaitTimeoutMs?: number;
  /** Per chat-request timeout passed to ConsumerService. Defaults to undefined (no timeout). */
  requestTimeoutMs?: number;
}

interface Session {
  roomId: string;
  network: Network;
  consumer: ConsumerService;
  voiceConsumer: VoiceConsumerService;
  providerId: string | null;
  providerModels: string[] | undefined;
  providerWaiters: Array<(providerId: string) => void>;
}

export class ConsumerClient {
  private readonly options: ConsumerClientOptions;
  private readonly listeners = new Set<ConsumerStatusListener>();
  private currentStatus: ConsumerStatus = { phase: "idle" };

  private session: Session | null = null;
  private joinPromise: Promise<Session> | null = null;
  private joinPromiseRoomId: string | null = null;
  private joinGeneration = 0;

  constructor(options: ConsumerClientOptions) {
    this.options = options;
  }

  get status(): ConsumerStatus {
    return this.currentStatus;
  }

  /** Subscribes to consumer connection status changes. Returns an unsubscribe function. */
  onStatusChange(listener: ConsumerStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitStatus(status: ConsumerStatus): void {
    this.currentStatus = status;
    this.listeners.forEach((listener) => listener(status));
  }

  /**
   * Eagerly connects to the LLM Network room and starts discovering a
   * provider, without waiting for an actual request. Errors are surfaced via
   * onStatusChange (phase: 'error'); this method itself never throws so
   * callers can fire-and-forget it.
   */
  async connect(roomId: string): Promise<void> {
    const trimmedRoomId = roomId.trim();
    if (!trimmedRoomId) return;
    try {
      await this.ensureSession(trimmedRoomId);
    } catch {
      // Status already emitted by ensureSession/createSession; nothing else to do.
    }
  }

  /**
   * Tears down the active/pending consumer session (if any) and resets status
   * to idle.
   */
  disconnect(): void {
    if (this.session) {
      this.session.network.destroy();
      this.session = null;
    }
    // Bump the generation so that any in-flight join (already past the point
    // where ensureSession could null it out here) is recognized as stale when
    // it resolves, and its `created.network` gets destroyed instead of being
    // adopted as the active session.
    this.joinGeneration += 1;
    this.joinPromise = null;
    this.joinPromiseRoomId = null;
    this.emitStatus({ phase: "idle" });
  }

  /** Sends a chat request over the LLM Network room and resolves with the full reply text. */
  async requestChat(
    roomId: string,
    messages: ChatMessage[],
    options: { model?: string; onDelta?: (delta: string, full: string) => void } = {},
  ): Promise<string> {
    const { session, providerId } = await this.sessionWithProvider(roomId);
    return session.consumer.request(providerId, messages, {
      model: options.model,
      onDelta: options.onDelta,
      timeoutMs: this.options.requestTimeoutMs,
    });
  }

  /** Requests speech synthesis over the LLM Network room; resolves with the audio Blob. */
  async requestTts(roomId: string, params: { text: string; model?: string; voice?: string }): Promise<Blob> {
    const { session, providerId } = await this.sessionWithProvider(roomId);
    return session.voiceConsumer.requestTts(providerId, params);
  }

  /** Sends audio for transcription over the LLM Network room; resolves with the text. */
  async requestStt(roomId: string, params: { audio: Blob; model?: string; fileName?: string }): Promise<string> {
    const { session, providerId } = await this.sessionWithProvider(roomId);
    return session.voiceConsumer.requestStt(providerId, params.audio, {
      model: params.model,
      fileName: params.fileName,
    });
  }

  private async sessionWithProvider(roomId: string): Promise<{ session: Session; providerId: string }> {
    const trimmedRoomId = roomId.trim();
    if (!trimmedRoomId) throw new MistaiError("NO_ROOM_ID", NO_ROOM_ID_MESSAGE);
    const session = await this.ensureSession(trimmedRoomId);
    const providerId = await this.waitForProvider(session);
    return { session, providerId };
  }

  private createSession(roomId: string): Promise<Session> {
    return new Promise((resolve, reject) => {
      const pendingSession: Session = {
        roomId,
        network: null as unknown as Network,
        consumer: null as unknown as ConsumerService,
        voiceConsumer: null as unknown as VoiceConsumerService,
        providerId: null,
        providerModels: undefined,
        providerWaiters: [],
      };

      const network = new Network({
        createNode: this.options.createNode,
        nodeIdStorageKey: this.options.nodeIdStorageKey,
        callbacks: {
          onMessage: (fromId, msg) => {
            if (msg.type === "provider_hello") {
              if (!pendingSession.providerId) {
                pendingSession.providerId = fromId;
                pendingSession.providerModels = msg.models;
                // Identify ourselves so the provider can label us a consumer.
                network.send(fromId, { v: 1, type: "consumer_hello" });
                pendingSession.providerWaiters.splice(0).forEach((waiter) => waiter(fromId));
                this.emitStatus({
                  phase: "connected",
                  providerId: fromId,
                  ...(msg.models !== undefined ? { models: msg.models } : {}),
                });
              } else if (fromId === pendingSession.providerId) {
                // Same provider re-announcing — refresh its advertised model list.
                pendingSession.providerModels = msg.models;
                this.emitStatus({
                  phase: "connected",
                  providerId: fromId,
                  ...(msg.models !== undefined ? { models: msg.models } : {}),
                });
              }
              return;
            }
            if (msg.type === "tts_response" || msg.type === "stt_response" || msg.type === "voice_error") {
              pendingSession.voiceConsumer.handleMessage(msg);
              return;
            }
            pendingSession.consumer.handleMessage(msg);
          },
          onPeerDisconnected: (peerId) => {
            if (pendingSession.providerId === peerId) {
              pendingSession.providerId = null;
              pendingSession.providerModels = undefined;
              // The provider that was serving our in-flight requests is gone;
              // reject them now instead of leaving callers hung until timeout.
              const err = new MistaiError("PROVIDER_DISCONNECTED", PROVIDER_DISCONNECTED_MESSAGE);
              pendingSession.voiceConsumer.rejectAll(err);
              pendingSession.consumer.rejectAll(err);
              this.emitStatus({ phase: "searching" });
            }
          },
        },
      });
      pendingSession.network = network;
      pendingSession.consumer = new ConsumerService((toId, msg) => network.send(toId, msg));
      pendingSession.voiceConsumer = new VoiceConsumerService((toId, msg) => network.send(toId, msg));

      network
        .join(roomId)
        .then(() => {
          // Announce presence to anyone already in the room so providers can
          // count/label us even before our first request.
          network.send(null, { v: 1, type: "consumer_hello" });
          this.emitStatus({ phase: "searching" });
          resolve(pendingSession);
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          this.emitStatus({ phase: "error", message, code: "JOIN_FAILED" });
          reject(err instanceof Error ? err : new MistaiError("JOIN_FAILED", message));
        });
    });
  }

  private async ensureSession(roomId: string): Promise<Session> {
    if (this.session && this.session.roomId === roomId) return this.session;
    if (this.session) {
      this.session.network.destroy();
      this.session = null;
    }
    if (this.joinPromise && this.joinPromiseRoomId !== roomId) {
      // A join for a different (stale) roomId is in flight — abandon it. Its
      // resolution handler will notice the generation has moved on and tear
      // down the connection instead of adopting it as the active session.
      this.joinPromise = null;
      this.joinPromiseRoomId = null;
    }
    if (!this.joinPromise) {
      const generation = ++this.joinGeneration;
      this.joinPromiseRoomId = roomId;
      this.emitStatus({ phase: "joining" });
      this.joinPromise = this.createSession(roomId)
        .then((created) => {
          if (generation !== this.joinGeneration) {
            // A newer join (different roomId, or an explicit disconnect) has
            // superseded this one. Don't adopt it as the active session —
            // tear it down instead so the connection doesn't leak.
            created.network.destroy();
            throw new Error("stale network join superseded");
          }
          this.session = created;
          this.joinPromise = null;
          this.joinPromiseRoomId = null;
          return created;
        })
        .catch((err) => {
          if (generation === this.joinGeneration) {
            this.joinPromise = null;
            this.joinPromiseRoomId = null;
          }
          throw err;
        });
    }
    return this.joinPromise;
  }

  private waitForProvider(current: Session): Promise<string> {
    if (current.providerId) return Promise.resolve(current.providerId);

    this.emitStatus({ phase: "searching" });

    const timeoutMs = this.options.providerWaitTimeoutMs ?? DEFAULT_PROVIDER_WAIT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = current.providerWaiters.indexOf(waiter);
        if (index >= 0) current.providerWaiters.splice(index, 1);
        this.emitStatus({ phase: "error", message: PROVIDER_NOT_FOUND_MESSAGE, code: "PROVIDER_NOT_FOUND" });
        reject(new MistaiError("PROVIDER_NOT_FOUND", PROVIDER_NOT_FOUND_MESSAGE));
      }, timeoutMs);

      function waiter(providerId: string): void {
        clearTimeout(timer);
        resolve(providerId);
      }

      current.providerWaiters.push(waiter);
    });
  }
}

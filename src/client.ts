// Consumer-facing entry point for LLM Network requests. Lazily joins the
// configured mist room on first use and maintains a table of announced
// providers (keyed by the provider_hello sender), matching each request to
// an eligible provider by service ("chat"/"tts"/"stt") and, when requested,
// by advertised model — with a single-retry failover to another eligible
// provider on disconnect/timeout/unsupported_service. The session is reused
// across requests as long as the room id doesn't change.
//
// Reworked from tc-translate/src/lib/mistllm/client.ts (a module singleton)
// into an instantiable class; apps may still keep a module singleton
// themselves. Improvements over the reference: consumer_hello is broadcast
// after joining so providers can label consumers, provider_hello.models is
// captured into the status, and (this revision) multiple concurrent
// providers are tracked and matched per-request instead of pinning to the
// first hello ever received.

import { Network, type MistNodeLike } from "./node.js";
import { MistaiError, type MistaiErrorCode } from "./errors.js";
import { ConsumerService } from "./consumer.js";
import { VoiceConsumerService } from "./voice-consumer.js";
import { helloServices, ERROR_CODE_UNSUPPORTED_SERVICE, type ChatMessage } from "./protocol.js";

const DEFAULT_PROVIDER_WAIT_TIMEOUT_MS = 10_000;
// Matches VoiceConsumerService's REQUEST_TIMEOUT_MS default so chat and
// voice requests fail on the same timescale instead of chat hanging forever.
const DEFAULT_CHAT_TIMEOUT_MS = 120_000;
const PROVIDER_NOT_FOUND_MESSAGE = "No provider found on the LLM Network.";
const NO_ROOM_ID_MESSAGE = "LLM Network room ID is not set.";
const PROVIDER_DISCONNECTED_MESSAGE = "Connection to the provider was lost.";

/** A service name a provider can announce; e.g. "chat" | "tts" | "stt" | "embedding". */
type ServiceName = string;

/** What the consumer knows about one announced provider. */
interface ProviderInfo {
  models?: string[];
  services: readonly string[];
}

/** Result of matching a request to a provider: which one, and which model (if any) to send. */
export interface ProviderSelection {
  providerId: string;
  model?: string;
}

interface ProviderWaiter {
  service: ServiceName;
  model: string | undefined;
  resolve: (selection: ProviderSelection) => void;
}

/**
 * Consumer-side connection state, surfaced to the UI so it can show more than
 * just idle/connected. Mirrors the lifecycle: join the room, wait for a
 * provider_hello, then hold the provider table once one or more arrive.
 */
export type ConsumerStatus =
  | { phase: "idle" }
  | { phase: "joining" }
  | { phase: "searching" }
  | {
      phase: "connected";
      /** Id of a representative provider (the first one announced), kept for backward compatibility. */
      providerId: string;
      /** Union of every announced provider's models, deduped. Absent if none advertised any. */
      models?: string[];
      /** Every currently known provider in the table. */
      providers: Array<{ id: string; models?: string[]; services: readonly string[] }>;
    }
  | { phase: "error"; message: string; code?: MistaiErrorCode };

export type ConsumerStatusListener = (status: ConsumerStatus) => void;

export interface ConsumerClientOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  /** localStorage key for the persistent node id. Defaults to "mistai:node-id". */
  nodeIdStorageKey?: string;
  /** How long to wait for an eligible provider_hello before failing a request. Defaults to 10s. */
  providerWaitTimeoutMs?: number;
  /**
   * Per chat-request timeout passed to ConsumerService. Defaults to 120s
   * (matching the voice request timeout) so a chat request can't hang
   * forever. Pass 0 to disable the timeout and wait indefinitely.
   */
  requestTimeoutMs?: number;
}

interface Session {
  roomId: string;
  network: Network;
  consumer: ConsumerService;
  voiceConsumer: VoiceConsumerService;
  providers: Map<string, ProviderInfo>;
  providerWaiters: ProviderWaiter[];
}

/** Picks a uniformly random element from a non-empty array. */
function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Union of `models` across every provider entry that advertised one; undefined if none did. */
function unionModels(entries: ReadonlyArray<readonly [string, ProviderInfo]>): string[] | undefined {
  const advertised = entries.filter(([, info]) => info.models !== undefined);
  if (advertised.length === 0) return undefined;
  const set = new Set<string>();
  for (const [, info] of advertised) for (const m of info.models!) set.add(m);
  return [...set];
}

/**
 * Matches a request to an eligible provider from the table:
 *  1. Narrow to providers announcing `service` (via provider_hello.services;
 *     see helloServices()), excluding any id in `exclude`.
 *  2. If a `model` was requested: prefer providers that advertised it in
 *     `models`; else prefer providers that didn't advertise a models list at
 *     all (send the request without a model so the provider's own default
 *     applies); else fall back to any eligible provider, sending the model
 *     anyway as a best effort (the upstream decides).
 *  3. Ties within a tier are broken randomly.
 * Returns null when no eligible provider exists.
 */
export function selectProvider(
  providers: ReadonlyMap<string, ProviderInfo>,
  service: ServiceName,
  model: string | undefined,
  exclude?: ReadonlySet<string>,
): ProviderSelection | null {
  const eligible = [...providers.entries()].filter(
    ([id, info]) => info.services.includes(service) && !exclude?.has(id),
  );
  if (eligible.length === 0) return null;

  if (model === undefined) {
    return { providerId: pickRandom(eligible)[0] };
  }

  const withModel = eligible.filter(([, info]) => info.models?.includes(model));
  if (withModel.length > 0) {
    return { providerId: pickRandom(withModel)[0], model };
  }

  const modelListUnknown = eligible.filter(([, info]) => info.models === undefined);
  if (modelListUnknown.length > 0) {
    // These providers never advertised a models list — omit `model` and let
    // the provider apply its own default rather than guessing.
    return { providerId: pickRandom(modelListUnknown)[0] };
  }

  return { providerId: pickRandom(eligible)[0], model };
}

/**
 * Whether `err` justifies a single failover attempt to another eligible
 * provider: disconnects, request timeouts, and capability-mismatch
 * (`unsupported_service`) rejections qualify; other remote errors don't, so
 * real upstream failures aren't hidden behind a silent provider switch.
 * Exported for apps that own their transport (Pattern B) and implement the
 * retry loop themselves — keeps their policy identical to ConsumerClient's.
 */
export function isFailoverEligible(err: unknown): boolean {
  if (!(err instanceof MistaiError)) return false;
  if (err.code === "PROVIDER_DISCONNECTED") return true;
  if (err.code === "REQUEST_TIMEOUT" || err.code === "TTS_TIMEOUT" || err.code === "STT_TIMEOUT") return true;
  // Capability mismatch (the peer never supported this service at all) is
  // safe to retry elsewhere; other REMOTE_ERROR causes (upstream failures)
  // are not retried so real errors aren't hidden behind a silent switch.
  if (err.code === "REMOTE_ERROR" && err.details?.code === ERROR_CODE_UNSUPPORTED_SERVICE) return true;
  return false;
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
   * Eagerly connects to the LLM Network room and starts discovering
   * providers, without waiting for an actual request. Errors are surfaced via
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
    const session = await this.ensureTrimmedSession(roomId);
    const timeoutMs = this.effectiveChatTimeoutMs();
    // Tracks whether any output has already reached the caller: once a
    // stream has started, failing over to another provider would produce
    // duplicate/garbled output, so failover is only attempted before the
    // first chunk arrives.
    let receivedChunk = false;
    const onDelta = (delta: string, full: string) => {
      receivedChunk = true;
      options.onDelta?.(delta, full);
    };
    return this.requestWithFailover(
      session,
      "chat",
      options.model,
      (providerId, model) => session.consumer.request(providerId, messages, { model, onDelta, timeoutMs }),
      () => !receivedChunk,
    );
  }

  /** Requests speech synthesis over the LLM Network room; resolves with the audio Blob. */
  async requestTts(roomId: string, params: { text: string; model?: string; voice?: string }): Promise<Blob> {
    const session = await this.ensureTrimmedSession(roomId);
    return this.requestWithFailover(session, "tts", params.model, (providerId, model) =>
      session.voiceConsumer.requestTts(providerId, { text: params.text, model, voice: params.voice }),
    );
  }

  /** Sends audio for transcription over the LLM Network room; resolves with the text. */
  async requestStt(roomId: string, params: { audio: Blob; model?: string; fileName?: string }): Promise<string> {
    const session = await this.ensureTrimmedSession(roomId);
    return this.requestWithFailover(session, "stt", params.model, (providerId, model) =>
      session.voiceConsumer.requestStt(providerId, params.audio, { model, fileName: params.fileName }),
    );
  }

  private async ensureTrimmedSession(roomId: string): Promise<Session> {
    const trimmedRoomId = roomId.trim();
    if (!trimmedRoomId) throw new MistaiError("NO_ROOM_ID", NO_ROOM_ID_MESSAGE);
    return this.ensureSession(trimmedRoomId);
  }

  private effectiveChatTimeoutMs(): number | undefined {
    const configured = this.options.requestTimeoutMs;
    if (configured === undefined) return DEFAULT_CHAT_TIMEOUT_MS;
    return configured === 0 ? undefined : configured;
  }

  /**
   * Waits for (or immediately returns) an eligible provider, sends the
   * request via `attempt`, and — if it fails with a failover-eligible error
   * and `canRetry()` still allows it — retries exactly once against a
   * different eligible provider. Throws the original error if no other
   * candidate exists or the failure isn't failover-eligible.
   */
  private async requestWithFailover<T>(
    session: Session,
    service: ServiceName,
    model: string | undefined,
    attempt: (providerId: string, model: string | undefined) => Promise<T>,
    canRetry: () => boolean = () => true,
  ): Promise<T> {
    const first = await this.waitForEligibleProvider(session, service, model);
    try {
      return await attempt(first.providerId, first.model);
    } catch (err) {
      if (!canRetry() || !isFailoverEligible(err)) throw err;
      const retry = selectProvider(session.providers, service, model, new Set([first.providerId]));
      if (!retry) throw err;
      return attempt(retry.providerId, retry.model);
    }
  }

  private createSession(roomId: string): Promise<Session> {
    return new Promise((resolve, reject) => {
      const pendingSession: Session = {
        roomId,
        network: null as unknown as Network,
        consumer: null as unknown as ConsumerService,
        voiceConsumer: null as unknown as VoiceConsumerService,
        providers: new Map(),
        providerWaiters: [],
      };

      const network = new Network({
        createNode: this.options.createNode,
        nodeIdStorageKey: this.options.nodeIdStorageKey,
        callbacks: {
          onMessage: (fromId, msg) => {
            if (msg.type === "provider_hello") {
              pendingSession.providers.set(fromId, { models: msg.models, services: helloServices(msg) });
              // Identify ourselves so the provider can label us a consumer.
              network.send(fromId, { v: 1, type: "consumer_hello" });
              this.resolveProviderWaiters(pendingSession);
              this.emitTableStatus(pendingSession);
              return;
            }
            if (msg.type === "tts_response" || msg.type === "stt_response" || msg.type === "voice_error") {
              pendingSession.voiceConsumer.handleMessage(msg);
              return;
            }
            pendingSession.consumer.handleMessage(msg);
          },
          onPeerDisconnected: (peerId) => {
            if (!pendingSession.providers.delete(peerId)) return;
            // Only the requests that were actually sent to this provider are
            // rejected now — other in-flight requests to other providers in
            // the table are left alone instead of being cancelled too.
            const err = new MistaiError("PROVIDER_DISCONNECTED", PROVIDER_DISCONNECTED_MESSAGE);
            pendingSession.voiceConsumer.rejectByProvider(peerId, err);
            pendingSession.consumer.rejectByProvider(peerId, err);
            this.emitTableStatus(pendingSession);
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

  /** Emits the current connected/searching status computed from the provider table. */
  private emitTableStatus(session: Session): void {
    const entries = [...session.providers.entries()];
    if (entries.length === 0) {
      this.emitStatus({ phase: "searching" });
      return;
    }
    const [firstId] = entries[0];
    const models = unionModels(entries);
    this.emitStatus({
      phase: "connected",
      providerId: firstId,
      ...(models !== undefined ? { models } : {}),
      providers: entries.map(([id, info]) => ({ id, models: info.models, services: info.services })),
    });
  }

  /** Resolves any pending waitForEligibleProvider() calls the updated table can now satisfy. */
  private resolveProviderWaiters(session: Session): void {
    if (session.providerWaiters.length === 0) return;
    const remaining: ProviderWaiter[] = [];
    for (const waiter of session.providerWaiters) {
      const selection = selectProvider(session.providers, waiter.service, waiter.model);
      if (selection) waiter.resolve(selection);
      else remaining.push(waiter);
    }
    session.providerWaiters = remaining;
  }

  /** Resolves immediately if an eligible provider already exists, otherwise waits for one. */
  private waitForEligibleProvider(
    session: Session,
    service: ServiceName,
    model: string | undefined,
  ): Promise<ProviderSelection> {
    const immediate = selectProvider(session.providers, service, model);
    if (immediate) return Promise.resolve(immediate);

    // Only drop to "searching" if the table is empty — if other providers
    // are already known (just none eligible for this service/model yet),
    // the connection itself is still "connected".
    if (session.providers.size === 0) this.emitStatus({ phase: "searching" });

    const timeoutMs = this.options.providerWaitTimeoutMs ?? DEFAULT_PROVIDER_WAIT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter: ProviderWaiter = {
        service,
        model,
        resolve: (selection) => {
          clearTimeout(timer);
          resolve(selection);
        },
      };
      timer = setTimeout(() => {
        const index = session.providerWaiters.indexOf(waiter);
        if (index >= 0) session.providerWaiters.splice(index, 1);
        this.emitStatus({ phase: "error", message: PROVIDER_NOT_FOUND_MESSAGE, code: "PROVIDER_NOT_FOUND" });
        reject(new MistaiError("PROVIDER_NOT_FOUND", PROVIDER_NOT_FOUND_MESSAGE));
      }, timeoutMs);
      session.providerWaiters.push(waiter);
    });
  }
}

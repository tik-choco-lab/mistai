// Consumer- and provider-side logic for tunneling an OpenAI-compatible HTTP
// request/response pair over a mist room: a consumer sends path+method+body,
// a provider peer forwards it to its own upstream (with its own API key) and
// relays the response back. Built on the native oai_* wire messages
// (./protocol.ts) — no codec fork needed, `Network`/`decode`/`encode` already
// understand them.
//
// Modeled closely on VoiceConsumerService (chunked request/response
// correlation by id) and ConsumerClient (room join + provider-table
// bookkeeping) — see ./voice-consumer.ts and ./client.ts. Uses MistaiError
// for every thrown/propagated error so apps can localize it via
// formatMistaiError (./messages.ts).
//
// Ported from tc-translate/src/lib/p2p/tunnel.ts, the app-level fork this
// was upstreamed from. Differences from that fork: no ExtendedNetwork (the
// library's own Network now decodes oai_* natively); base64/chunk helpers
// come from ./base64.ts instead of file-local copies.

import { MistaiError } from "./errors.js";
import { base64ToUtf8, bytesToBase64, chunkBase64, utf8ToBase64 } from "./base64.js";
import { randomId } from "./id.js";
import { Network, type MistNodeLike } from "./node.js";
import {
  OAI_TUNNEL_SERVICE,
  helloServices,
  type OaiErrorMsg,
  type OaiRequestMsg,
  type OaiResponseMsg,
  type ProtocolMessage,
} from "./protocol.js";

// Base64 chars per wire message — mirrors VOICE_CHUNK_SIZE (mist's reliable
// data channel is only safe for ~16KB per message).
export const OAI_CHUNK_SIZE = 12 * 1024;
// Hard ceiling on reassembled base64 from a single (possibly malicious) peer —
// mirrors MAX_AUDIO_BASE64_CHARS.
export const MAX_OAI_BASE64_CHARS = 24 * 1024 * 1024;
// A request must complete within this window; matches the library's chat/
// voice REQUEST_TIMEOUT_MS default so nothing hangs forever if a provider
// vanishes mid-response.
export const OAI_REQUEST_TIMEOUT_MS = 120_000;
// How long to wait for an oai-capable provider_hello before giving up.
export const OAI_PROVIDER_WAIT_TIMEOUT_MS = 10_000;

const PROVIDER_NOT_FOUND_MESSAGE = "No provider found on the LLM Network.";
const NO_ROOM_ID_MESSAGE = "LLM Network room ID is not set.";
const PROVIDER_DISCONNECTED_MESSAGE = "Connection to the provider was lost.";

/** Picks a uniformly random element from a non-empty array. */
function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

// ---------------------------------------------------------------------------
// Consumer side.

export interface OaiTunnelClientOptions {
  /** Factory for the app's vendored mist node (e.g. `(id) => new MistNode(id)`). */
  createNode: (nodeId: string) => MistNodeLike;
  /**
   * localStorage key for this client's persistent node id. Apps using the
   * shared node facade (./shared-node.ts) multiplex every stack onto one
   * page-level node, so this should be the SAME key as the app's main
   * consumer/provider stacks — the tunnel is another handle on that node,
   * not a second peer.
   */
  nodeIdStorageKey: string;
  /** Per-request completion window. Defaults to {@link OAI_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
}

export interface OaiTunnelRequestInit {
  path: string;
  method?: "GET" | "POST";
  contentType?: string;
  body?: string;
}

export interface OaiTunnelResponse {
  status: number;
  contentType: string;
  body: string;
}

interface OaiProviderInfo {
  services: readonly string[];
}

interface ProviderWaiter {
  resolve: (providerId: string) => void;
}

interface PendingClientRequest {
  providerId: string;
  parts: Map<number, string>;
  lastSeq: number | null;
  status: number;
  contentType: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: OaiTunnelResponse) => void;
  reject: (err: Error) => void;
}

interface ClientSession {
  roomId: string;
  network: Network;
  providers: Map<string, OaiProviderInfo>;
  providerWaiters: ProviderWaiter[];
}

/**
 * Consumer side of the OAI tunnel: joins a mist room, waits for a peer
 * announcing the `oai` service, and round-trips one OpenAI-compatible HTTP
 * request per `request()` call. The session (room join + provider table) is
 * cached and reused across calls as long as the room id doesn't change,
 * mirroring ConsumerClient (./client.ts).
 */
export class OaiTunnelClient {
  private readonly createNode: (nodeId: string) => MistNodeLike;
  private readonly nodeIdStorageKey: string;
  private readonly requestTimeoutMs: number;
  private session: ClientSession | null = null;
  private joinPromise: Promise<ClientSession> | null = null;
  private joinPromiseRoomId: string | null = null;
  private joinGeneration = 0;
  private readonly pending = new Map<string, PendingClientRequest>();

  constructor(options: OaiTunnelClientOptions) {
    this.createNode = options.createNode;
    this.nodeIdStorageKey = options.nodeIdStorageKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? OAI_REQUEST_TIMEOUT_MS;
  }

  /**
   * Joins `roomId` (reusing the cached session until `roomId` changes or
   * disconnect() is called), waits for a provider whose provider_hello.services
   * includes {@link OAI_TUNNEL_SERVICE}, sends the request chunked, and
   * reassembles the response. `body`/the returned `body` are UTF-8 strings
   * (base64'd internally for the wire).
   */
  async request(roomId: string, req: OaiTunnelRequestInit): Promise<OaiTunnelResponse> {
    const trimmedRoomId = roomId.trim();
    if (!trimmedRoomId) throw new MistaiError("NO_ROOM_ID", NO_ROOM_ID_MESSAGE);
    const session = await this.ensureSession(trimmedRoomId);
    const providerId = await this.waitForProvider(session);
    return this.sendRequest(session, providerId, req);
  }

  /** Tears down the active/pending session and rejects every in-flight request. */
  disconnect(): void {
    if (this.session) {
      this.session.network.destroy();
      this.session = null;
    }
    // Bump the generation so an in-flight join (already past the point where
    // ensureSession could null it out here) is recognized as stale when it
    // resolves, and its network gets destroyed instead of adopted.
    this.joinGeneration += 1;
    this.joinPromise = null;
    this.joinPromiseRoomId = null;
    const err = new MistaiError("PROVIDER_DISCONNECTED", PROVIDER_DISCONNECTED_MESSAGE);
    for (const [id, entry] of [...this.pending.entries()]) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  private createSession(roomId: string): Promise<ClientSession> {
    return new Promise((resolve, reject) => {
      // `network` is assigned synchronously right after construction, before
      // `join()`'s async node.init() resolves and callbacks can fire — so by
      // the time any callback below runs, pendingSession.network is real.
      // Mirrors ConsumerClient's (./client.ts) pendingSession.network pattern.
      const pendingSession: ClientSession = {
        roomId,
        network: null as unknown as Network,
        providers: new Map(),
        providerWaiters: [],
      };
      const network = new Network({
        createNode: this.createNode,
        nodeIdStorageKey: this.nodeIdStorageKey,
        callbacks: {
          onMessage: (fromId, msg) => {
            if (msg.type === "provider_hello") {
              pendingSession.providers.set(fromId, { services: helloServices(msg) });
              this.resolveProviderWaiters(pendingSession);
              return;
            }
            if (msg.type === "oai_response" || msg.type === "oai_error") {
              this.handleTunnelMessage(msg);
              return;
            }
            // Everything else (llm_*, tts_*, stt_*, consumer_hello,
            // raft_message) is not relevant to this tunnel client.
          },
          onPeerDisconnected: (peerId) => {
            if (!pendingSession.providers.delete(peerId)) return;
            this.rejectByProvider(peerId, new MistaiError("PROVIDER_DISCONNECTED", PROVIDER_DISCONNECTED_MESSAGE));
          },
        },
      });
      pendingSession.network = network;
      network
        .join(roomId)
        .then(() => resolve(pendingSession))
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          reject(err instanceof Error ? err : new MistaiError("JOIN_FAILED", message));
        });
    });
  }

  private async ensureSession(roomId: string): Promise<ClientSession> {
    if (this.session && this.session.roomId === roomId) return this.session;
    if (this.session) {
      this.session.network.destroy();
      this.session = null;
    }
    if (this.joinPromise && this.joinPromiseRoomId !== roomId) {
      // A join for a different (stale) roomId is in flight — abandon it; its
      // resolution handler will notice the generation moved on (see below).
      this.joinPromise = null;
      this.joinPromiseRoomId = null;
    }
    if (!this.joinPromise) {
      const generation = ++this.joinGeneration;
      this.joinPromiseRoomId = roomId;
      this.joinPromise = this.createSession(roomId)
        .then((created) => {
          if (generation !== this.joinGeneration) {
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

  /** Resolves any pending waitForProvider() calls the updated table can now satisfy. */
  private resolveProviderWaiters(session: ClientSession): void {
    if (session.providerWaiters.length === 0) return;
    const eligible = [...session.providers.entries()].filter(([, info]) => info.services.includes(OAI_TUNNEL_SERVICE));
    if (eligible.length === 0) return;
    const waiters = session.providerWaiters;
    session.providerWaiters = [];
    for (const waiter of waiters) waiter.resolve(pickRandom(eligible)[0]);
  }

  /** Resolves immediately if an oai-capable provider already exists, otherwise waits for one. */
  private waitForProvider(session: ClientSession): Promise<string> {
    const eligible = [...session.providers.entries()].filter(([, info]) => info.services.includes(OAI_TUNNEL_SERVICE));
    if (eligible.length > 0) return Promise.resolve(pickRandom(eligible)[0]);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter: ProviderWaiter = {
        resolve: (providerId) => {
          clearTimeout(timer);
          resolve(providerId);
        },
      };
      timer = setTimeout(() => {
        const index = session.providerWaiters.indexOf(waiter);
        if (index >= 0) session.providerWaiters.splice(index, 1);
        reject(new MistaiError("PROVIDER_NOT_FOUND", PROVIDER_NOT_FOUND_MESSAGE));
      }, OAI_PROVIDER_WAIT_TIMEOUT_MS);
      session.providerWaiters.push(waiter);
    });
  }

  private sendRequest(session: ClientSession, providerId: string, req: OaiTunnelRequestInit): Promise<OaiTunnelResponse> {
    const id = randomId();
    const method = req.method ?? "POST";
    const contentType = req.contentType ?? "application/json";
    const base64 = utf8ToBase64(req.body ?? "");
    const parts = chunkBase64(base64, OAI_CHUNK_SIZE);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new MistaiError("REQUEST_TIMEOUT", "OAI tunnel request timed out."));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        providerId,
        parts: new Map(),
        lastSeq: null,
        status: 0,
        contentType: "",
        timer,
        resolve,
        reject,
      });
      parts.forEach((data, index) => {
        const last = index === parts.length - 1;
        const base: OaiRequestMsg = { v: 1, type: "oai_request", id, seq: index, last, data };
        const withMeta: OaiRequestMsg = index === 0 ? { ...base, path: req.path, method, contentType } : base;
        session.network.send(providerId, withMeta);
      });
    });
  }

  private handleTunnelMessage(msg: OaiResponseMsg | OaiErrorMsg): void {
    if (msg.type === "oai_error") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.reject(new MistaiError("REMOTE_ERROR", msg.message, msg.code !== undefined ? { code: msg.code } : undefined));
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (entry.parts.has(msg.seq)) return; // duplicate chunk; ignore
    if (msg.seq === 0) {
      entry.status = msg.status ?? 200;
      entry.contentType = msg.contentType ?? "application/octet-stream";
    }
    entry.parts.set(msg.seq, msg.data);
    if (msg.last) entry.lastSeq = msg.seq;

    let total = 0;
    for (const part of entry.parts.values()) total += part.length;
    if (total > MAX_OAI_BASE64_CHARS) {
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.reject(new MistaiError("UPSTREAM_BAD_RESPONSE", "OAI tunnel response exceeded the maximum allowed size."));
      return;
    }

    if (entry.lastSeq === null || entry.parts.size !== entry.lastSeq + 1) return; // not complete yet
    const lastSeq = entry.lastSeq;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    let base64 = "";
    for (let i = 0; i <= lastSeq; i += 1) {
      const part = entry.parts.get(i);
      if (part === undefined) {
        // Can't happen given the size-derived completeness check above
        // (parts.size === lastSeq + 1 implies every index is present), but
        // guard defensively rather than assemble a hole into the body.
        entry.reject(new MistaiError("UPSTREAM_BAD_RESPONSE", "OAI tunnel response was missing a chunk."));
        return;
      }
      base64 += part;
    }
    try {
      entry.resolve({ status: entry.status, contentType: entry.contentType, body: base64ToUtf8(base64) });
    } catch (err) {
      entry.reject(
        new MistaiError("UPSTREAM_BAD_RESPONSE", err instanceof Error ? err.message : "Failed to decode OAI tunnel response."),
      );
    }
  }

  /** Rejects only the in-flight requests sent to `providerId`. */
  private rejectByProvider(providerId: string, err: Error): void {
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.providerId !== providerId) continue;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Provider side.

export interface OaiUpstream {
  baseUrl: string;
  apiKey: string;
  /**
   * Rewrite the parsed JSON body before it's forwarded upstream — e.g. to
   * force `stream: false` (v1 of this tunnel has no support for relaying a
   * streamed upstream response back over oai_response chunks incrementally;
   * a provider that wants streaming semantics must buffer the full stream
   * itself and return it in one shot, or use rewriteBody to disable
   * upstream streaming altogether) or to swap the model id in for the
   * preset's real upstream model name.
   */
  rewriteBody?: (body: unknown) => unknown;
}

/**
 * Returns null to refuse a path outright (unknown/disallowed path or no
 * upstream configured for it) - answered with code 'unsupported_path'. May
 * also THROW to refuse with a specific reason (e.g. a model that isn't in the
 * share list) - the thrown message is relayed as an oai_error with code
 * 'request_rejected' instead of being forwarded upstream. Enforcing a path
 * allowlist (which paths this provider proxies at all, e.g. only
 * `/chat/completions`, `/models`, `/embeddings`) is entirely this resolver's
 * responsibility — the provider class itself has no opinion on paths.
 */
export type OaiUpstreamResolver = (path: string, body: unknown) => OaiUpstream | null;

interface IncomingRequest {
  parts: Map<number, string>;
  lastSeq: number | null;
  path: string;
  method: string;
  contentType: string;
}

/**
 * Provider side of the OAI tunnel: reassembles oai_request chunks and
 * forwards the decoded request to whichever upstream `resolveUpstream`
 * chooses, then relays the upstream's HTTP response back as oai_response
 * chunks. One instance can serve requests from any number of peers
 * concurrently — reassembly buffers are keyed per (fromId, id).
 */
export class OaiTunnelProvider {
  private readonly send: (toId: string, msg: ProtocolMessage) => void;
  private readonly resolveUpstream: OaiUpstreamResolver;
  private readonly pending = new Map<string, IncomingRequest>();

  constructor(send: (toId: string, msg: ProtocolMessage) => void, resolveUpstream: OaiUpstreamResolver) {
    this.send = send;
    this.resolveUpstream = resolveUpstream;
  }

  /** Returns true when the message was an oai_* it consumed; false otherwise. */
  handleMessage(fromId: string, msg: ProtocolMessage): boolean {
    if (msg.type !== "oai_request") return false;
    this.handleRequest(fromId, msg);
    return true;
  }

  /** Drops reassembly buffers for a disconnected peer. */
  dropPeer(peerId: string): void {
    const prefix = `${peerId}:`;
    for (const key of [...this.pending.keys()]) {
      if (key.startsWith(prefix)) this.pending.delete(key);
    }
  }

  private handleRequest(fromId: string, msg: OaiRequestMsg): void {
    const key = `${fromId}:${msg.id}`;
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { parts: new Map(), lastSeq: null, path: "", method: "POST", contentType: "application/json" };
      this.pending.set(key, entry);
    }
    if (entry.parts.has(msg.seq)) return; // duplicate chunk; ignore
    if (msg.seq === 0) {
      entry.path = msg.path ?? "";
      entry.method = msg.method ?? "POST";
      entry.contentType = msg.contentType ?? "application/json";
    }
    entry.parts.set(msg.seq, msg.data);
    if (msg.last) entry.lastSeq = msg.seq;

    let total = 0;
    for (const part of entry.parts.values()) total += part.length;
    if (total > MAX_OAI_BASE64_CHARS) {
      this.pending.delete(key);
      this.send(fromId, {
        v: 1,
        type: "oai_error",
        id: msg.id,
        message: "Request exceeded the maximum allowed size.",
        code: "request_too_large",
      });
      return;
    }

    if (entry.lastSeq === null || entry.parts.size !== entry.lastSeq + 1) return; // not complete yet
    this.pending.delete(key);
    void this.dispatch(fromId, msg.id, entry);
  }

  private async dispatch(fromId: string, id: string, entry: IncomingRequest): Promise<void> {
    let base64 = "";
    for (let i = 0; i <= (entry.lastSeq ?? -1); i += 1) {
      const part = entry.parts.get(i);
      if (part === undefined) {
        this.send(fromId, { v: 1, type: "oai_error", id, message: "Request was missing a chunk." });
        return;
      }
      base64 += part;
    }

    let bodyText: string;
    try {
      bodyText = base64ToUtf8(base64);
    } catch {
      this.send(fromId, { v: 1, type: "oai_error", id, message: "Failed to decode request body." });
      return;
    }

    // contentType already defaulted to 'application/json' when absent (see
    // handleRequest), so only an explicit non-JSON contentType opts out.
    const looksJson = /json/i.test(entry.contentType);
    let parsedBody: unknown;
    let bodyWasParsed = false;
    if (bodyText.length > 0 && looksJson) {
      try {
        parsedBody = JSON.parse(bodyText);
        bodyWasParsed = true;
      } catch {
        // Parse failure -> body stays raw string; resolver gets undefined.
      }
    }

    let upstream: OaiUpstream | null;
    try {
      upstream = this.resolveUpstream(entry.path, bodyWasParsed ? parsedBody : undefined);
    } catch (err) {
      this.send(fromId, {
        v: 1,
        type: "oai_error",
        id,
        message: err instanceof Error ? err.message : "The provider rejected the request.",
        code: "request_rejected",
      });
      return;
    }
    if (!upstream) {
      this.send(fromId, {
        v: 1,
        type: "oai_error",
        id,
        message: "This provider does not proxy that path.",
        code: "unsupported_path",
      });
      return;
    }

    const outgoingBody = bodyWasParsed ? (upstream.rewriteBody ? upstream.rewriteBody(parsedBody) : parsedBody) : bodyText;

    const url = `${upstream.baseUrl.replace(/\/+$/, "")}${entry.path}`;
    const method = entry.method || "POST";
    const headers: Record<string, string> = {};
    if (bodyText.length > 0) headers["Content-Type"] = entry.contentType || "application/json";
    // Never forward any consumer-supplied auth: the oai_request wire protocol
    // carries no auth field by design — only this provider's own upstream
    // apiKey is used, and the consumer never sees it.
    if (upstream.apiKey.trim().length > 0) headers.Authorization = `Bearer ${upstream.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: method === "GET" ? undefined : typeof outgoingBody === "string" ? outgoingBody : JSON.stringify(outgoingBody),
      });
    } catch (err) {
      this.send(fromId, {
        v: 1,
        type: "oai_error",
        id,
        message: err instanceof Error ? err.message : "Upstream request failed.",
      });
      return;
    }

    let responseBytes: Uint8Array;
    try {
      responseBytes = new Uint8Array(await response.arrayBuffer());
    } catch (err) {
      this.send(fromId, {
        v: 1,
        type: "oai_error",
        id,
        message: err instanceof Error ? err.message : "Failed to read the upstream response.",
      });
      return;
    }

    const responseContentType = response.headers.get("content-type") ?? "application/octet-stream";
    const parts = chunkBase64(bytesToBase64(responseBytes), OAI_CHUNK_SIZE);
    parts.forEach((data, index) => {
      const last = index === parts.length - 1;
      const base: OaiResponseMsg = { v: 1, type: "oai_response", id, seq: index, last, data };
      const withMeta: OaiResponseMsg =
        index === 0 ? { ...base, status: response.status, contentType: responseContentType } : base;
      this.send(fromId, withMeta);
    });
  }
}

// Consumer-side logic: sends llm_request messages and correlates streamed
// responses back to the originating request by id. Network I/O is injected
// for testability.
//
// Unified from tc-mistllm/src/lib/consumer.ts and
// tc-translate/src/lib/mistllm/consumer.ts, with the per-request timeout from
// tc-pdf-viewer/src/services/mistllm.js.

import type { ChatMessage, ProtocolMessage } from "./protocol.js";
import { randomId } from "./id.js";
import { MistaiError } from "./errors.js";

export type SendFn = (toId: string, msg: ProtocolMessage) => void;

export interface ConsumerRequestOptions {
  model?: string;
  onDelta?: (delta: string, full: string) => void;
  /**
   * Rejects the request if neither done nor error arrives within this window.
   * Any received chunk resets the timer — a streaming response is alive.
   * Undefined means no timeout.
   */
  timeoutMs?: number;
}

export interface PendingRequest {
  content: string;
  onDelta?: (delta: string, full: string) => void;
  resolve: (content: string) => void;
  reject: (err: Error) => void;
  /** Next seq expected from a sequenced sender; out-of-order chunks buffer here until it's their turn. */
  nextSeq: number;
  buffered: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
  timeoutMs?: number;
}

export class ConsumerService {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly send: SendFn;

  constructor(send: SendFn) {
    this.send = send;
  }

  /** Sends a chat request to `providerId` and resolves with the full assembled reply. */
  request(providerId: string, messages: ChatMessage[], options: ConsumerRequestOptions = {}): Promise<string> {
    const { model, onDelta, timeoutMs } = options;
    const id = randomId();
    return new Promise((resolve, reject) => {
      const entry: PendingRequest = {
        content: "",
        onDelta,
        resolve,
        reject,
        nextSeq: 0,
        buffered: new Map(),
        timer: null,
        timeoutMs,
      };
      this.pending.set(id, entry);
      this.resetTimeout(id, entry);
      const req: ProtocolMessage = model
        ? { v: 1, type: "llm_request", id, messages, model }
        : { v: 1, type: "llm_request", id, messages };
      this.send(providerId, req);
    });
  }

  /** Rejects every in-flight request, e.g. when the serving provider disconnects. */
  rejectAll(err: Error): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /** Feeds an incoming protocol message into request correlation. No-ops for unrelated types. */
  handleMessage(msg: ProtocolMessage): void {
    if (msg.type !== "llm_response_chunk" && msg.type !== "llm_response_done" && msg.type !== "llm_error") {
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;

    if (msg.type === "llm_response_chunk") {
      this.resetTimeout(msg.id, entry);
      this.applyChunk(entry, msg.delta, msg.seq);
    } else if (msg.type === "llm_response_done") {
      const final = msg.content ?? entry.content;
      this.settle(msg.id, entry);
      entry.resolve(final);
    } else if (msg.type === "llm_error") {
      this.settle(msg.id, entry);
      entry.reject(new MistaiError("REMOTE_ERROR", msg.message));
    }
  }

  private settle(id: string, entry: PendingRequest): void {
    this.pending.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private resetTimeout(id: string, entry: PendingRequest): void {
    if (entry.timeoutMs === undefined) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (!this.pending.has(id)) return;
      this.settle(id, entry);
      entry.reject(new MistaiError("REQUEST_TIMEOUT", "LLM request timed out."));
    }, entry.timeoutMs);
  }

  /**
   * Applies a chunk to `entry`, reordering by `seq` when present. Chunks
   * without a seq (legacy senders) are applied immediately in arrival order.
   */
  private applyChunk(entry: PendingRequest, delta: string, seq: number | undefined): void {
    if (seq === undefined) {
      entry.content += delta;
      entry.onDelta?.(delta, entry.content);
      return;
    }

    if (seq < entry.nextSeq) return; // stale duplicate
    if (seq > entry.nextSeq) {
      entry.buffered.set(seq, delta);
      return;
    }

    entry.content += delta;
    entry.onDelta?.(delta, entry.content);
    entry.nextSeq += 1;

    let next = entry.buffered.get(entry.nextSeq);
    while (next !== undefined) {
      entry.buffered.delete(entry.nextSeq);
      entry.content += next;
      entry.onDelta?.(next, entry.content);
      entry.nextSeq += 1;
      next = entry.buffered.get(entry.nextSeq);
    }
  }
}

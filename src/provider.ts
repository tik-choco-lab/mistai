// Provider-side logic: reacts to llm_request messages by calling an injected
// LLM function (the user's configured upstream API) and streaming the result
// back to the requester. Network I/O is injected so this can be unit-tested
// without mistlib or real fetch.
//
// Ported from tc-translate/src/lib/mistllm/provider.ts (the variant with the
// richer request log).

import type { ChatMessage, ProtocolMessage } from "./protocol.js";

export type LlmCallFn = (
  messages: ChatMessage[],
  model: string | undefined,
  onDelta: (delta: string) => void,
) => Promise<string>;

export type SendFn = (toId: string, msg: ProtocolMessage) => void;

export type ProviderLogStatus = "started" | "streaming" | "done" | "error";

export interface ProviderLogEntry {
  id: string;
  fromId: string;
  model?: string;
  status: ProviderLogStatus;
  startedAt: number;
  charCount: number;
  detail?: string;
}

export interface ProviderLogOptions {
  onRequestLog?: (entry: ProviderLogEntry) => void;
  /** Max number of log entries retained; oldest are dropped first. Defaults to 50. */
  maxLogEntries?: number;
}

export const DEFAULT_MAX_LOG_ENTRIES = 50;

export class ProviderService {
  private readonly send: SendFn;
  private readonly callLlm: LlmCallFn;
  private readonly options: ProviderLogOptions;
  private readonly logs: ProviderLogEntry[] = [];

  constructor(send: SendFn, callLlm: LlmCallFn, options: ProviderLogOptions = {}) {
    this.send = send;
    this.callLlm = callLlm;
    this.options = options;
  }

  /** Snapshot of the request log, most recent first. */
  getLogs(): ProviderLogEntry[] {
    return [...this.logs];
  }

  /** Handles a raw incoming protocol message. No-ops for anything but llm_request. */
  async handleMessage(fromId: string, msg: ProtocolMessage): Promise<void> {
    if (msg.type !== "llm_request") return;

    const entry: ProviderLogEntry = {
      id: msg.id,
      fromId,
      model: msg.model,
      status: "started",
      startedAt: Date.now(),
      charCount: 0,
    };
    this.pushLog(entry);

    let seq = 0;
    let charCount = 0;
    try {
      const content = await this.callLlm(msg.messages, msg.model, (delta) => {
        charCount += delta.length;
        this.pushLog({ ...entry, status: "streaming", charCount });
        this.send(fromId, { v: 1, type: "llm_response_chunk", id: msg.id, delta, seq: seq++ });
      });
      this.send(fromId, { v: 1, type: "llm_response_done", id: msg.id, content });
      this.pushLog({ ...entry, status: "done", charCount: content.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send(fromId, { v: 1, type: "llm_error", id: msg.id, message });
      this.pushLog({ ...entry, status: "error", charCount, detail: message });
    }
  }

  private pushLog(entry: ProviderLogEntry): void {
    const maxEntries = this.options.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES;
    const existingIndex = this.logs.findIndex((logEntry) => logEntry.id === entry.id);
    if (existingIndex >= 0) {
      this.logs[existingIndex] = entry;
    } else {
      this.logs.unshift(entry);
      if (this.logs.length > maxEntries) this.logs.length = maxEntries;
    }
    this.options.onRequestLog?.(entry);
  }
}

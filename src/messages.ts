// Canonical UI wording for the states and errors this library defines, in
// English and Japanese. Before this existed, each app hand-rolled its own
// labels and the terminology drifted ("provider" / "プロバイダ" /
// "プロバイダー" all coexisted); consuming these catalogs keeps every app's
// LLM Network UI consistent. Apps supporting other languages can provide
// their own MistaiMessages object with the same shape.

import { MistaiError, type MistaiErrorCode } from "./errors.js";

export interface MistaiMessages {
  /** Full labels for the consumer connection lifecycle (status lines, tooltips). */
  consumerPhase: {
    idle: string;
    joining: string;
    searching: string;
    connected: string;
    error: string;
  };
  /** Short labels for step-indicator UIs (未接続 → Room接続中 → …). */
  consumerStep: {
    idle: string;
    joining: string;
    searching: string;
    connected: string;
  };
  providerStatus: {
    idle: string;
    connecting: string;
    connected: string;
    error: string;
  };
  logStatus: {
    started: string;
    streaming: string;
    done: string;
    error: string;
  };
  /** Strings used by the shared UI components (`@tik-choco/mistai/preact`). */
  ui: {
    /** Tooltip/aria label on the consumer indicator toggle. */
    connectionTitle: string;
    details: string;
    nodeId: string;
    peersLine: (total: number, consumers: number) => string;
    requestLog: string;
    noRequests: string;
    showMore: (remaining: number) => string;
    charCount: (count: number) => string;
    /** Suffix after the "Serving" label in the provider summary line. */
    connectedSummary: (peers: number, requests: number) => string;
  };
  errors: Record<MistaiErrorCode, string>;
}

export const MESSAGES_EN: MistaiMessages = {
  consumerPhase: {
    idle: "Not connected",
    joining: "Joining the room...",
    searching: "Searching for a provider...",
    connected: "Connected to a provider",
    error: "Error",
  },
  consumerStep: {
    idle: "Not connected",
    joining: "Joining room",
    searching: "Finding provider",
    connected: "Connected",
  },
  providerStatus: {
    idle: "Not connected",
    connecting: "Connecting...",
    connected: "Serving",
    error: "Error",
  },
  logStatus: {
    started: "Received",
    streaming: "Generating",
    done: "Done",
    error: "Error",
  },
  ui: {
    connectionTitle: "LLM Network connection",
    details: "Details",
    nodeId: "Node ID",
    peersLine: (total, consumers) => `Connected peers: ${total} (consumers: ${consumers})`,
    requestLog: "Request log",
    noRequests: "No requests yet.",
    showMore: (remaining) => `Show more (${remaining} left)`,
    charCount: (count) => `${count} chars`,
    connectedSummary: (peers, requests) => `peers ${peers} · ${requests} requests`,
  },
  errors: {
    NO_ROOM_ID: "LLM Network room ID is not set.",
    JOIN_FAILED: "Failed to join the room.",
    PROVIDER_NOT_FOUND: "No provider found on the LLM Network.",
    PROVIDER_DISCONNECTED: "Connection to the provider was lost.",
    REQUEST_TIMEOUT: "The request timed out.",
    TTS_TEXT_TOO_LONG: "The text to speak is too long.",
    TTS_TIMEOUT: "Speech synthesis timed out.",
    STT_TIMEOUT: "Speech recognition timed out.",
    TTS_OUT_OF_ORDER: "Audio data arrived out of order.",
    TTS_AUDIO_TOO_LARGE: "The received audio data is too large.",
    TTS_DECODE_FAILED: "Failed to decode the audio data.",
    REMOTE_ERROR: "The provider reported an error.",
    UPSTREAM_REQUEST_FAILED: "The LLM API request failed.",
    UPSTREAM_HTTP_ERROR: "The LLM API returned an error.",
    UPSTREAM_BAD_RESPONSE: "The LLM API returned a response with an unexpected format.",
    MODEL_LIST_EMPTY: "Could not retrieve the model list.",
    ENDPOINT_NOT_CONFIGURED: "This provider has no such endpoint configured.",
  },
};

export const MESSAGES_JA: MistaiMessages = {
  consumerPhase: {
    idle: "未接続",
    joining: "Room に接続中...",
    searching: "プロバイダーを探索中...",
    connected: "プロバイダーに接続済み",
    error: "エラー",
  },
  consumerStep: {
    idle: "未接続",
    joining: "Room接続中",
    searching: "プロバイダー探索中",
    connected: "接続済み",
  },
  providerStatus: {
    idle: "未接続",
    connecting: "接続中...",
    connected: "提供中",
    error: "エラー",
  },
  logStatus: {
    started: "受信",
    streaming: "生成中",
    done: "完了",
    error: "エラー",
  },
  ui: {
    connectionTitle: "LLM Network 接続状態",
    details: "詳細",
    nodeId: "Node ID",
    peersLine: (total, consumers) => `接続ピア数: ${total}（うち consumer: ${consumers}）`,
    requestLog: "リクエストログ",
    noRequests: "まだリクエストはありません。",
    showMore: (remaining) => `もっと見る（残り ${remaining} 件）`,
    charCount: (count) => `${count}文字`,
    connectedSummary: (peers, requests) => `peer ${peers} · 処理 ${requests}件`,
  },
  errors: {
    NO_ROOM_ID: "LLM Network の Room ID が設定されていません。",
    JOIN_FAILED: "Room への接続に失敗しました。",
    PROVIDER_NOT_FOUND: "プロバイダーが見つかりません。",
    PROVIDER_DISCONNECTED: "プロバイダーとの接続が切断されました。",
    REQUEST_TIMEOUT: "リクエストがタイムアウトしました。",
    TTS_TEXT_TOO_LONG: "読み上げるテキストが長すぎます。",
    TTS_TIMEOUT: "音声合成がタイムアウトしました。",
    STT_TIMEOUT: "音声認識がタイムアウトしました。",
    TTS_OUT_OF_ORDER: "音声データを正しい順序で受信できませんでした。",
    TTS_AUDIO_TOO_LARGE: "受信した音声データが大きすぎます。",
    TTS_DECODE_FAILED: "音声データのデコードに失敗しました。",
    REMOTE_ERROR: "プロバイダー側でエラーが発生しました。",
    UPSTREAM_REQUEST_FAILED: "LLM API へのリクエストに失敗しました。",
    UPSTREAM_HTTP_ERROR: "LLM API がエラーを返しました。",
    UPSTREAM_BAD_RESPONSE: "LLM API の応答形式が不正です。",
    MODEL_LIST_EMPTY: "モデル一覧を取得できませんでした。",
    ENDPOINT_NOT_CONFIGURED: "このプロバイダーにはエンドポイントが設定されていません。",
  },
};

/**
 * User-facing message for any error coming out of a library code path.
 * MistaiError codes map through the catalog, except REMOTE_ERROR whose
 * message is authored by the remote provider and is shown as-is (the catalog
 * entry is only a fallback for an empty remote message). Non-MistaiError
 * errors keep their own message; non-Error values yield `fallback`.
 */
export function formatMistaiError(err: unknown, messages: MistaiMessages, fallback?: string): string {
  if (err instanceof MistaiError) {
    if (err.code === "REMOTE_ERROR") return err.message || messages.errors.REMOTE_ERROR;
    return messages.errors[err.code] ?? err.message;
  }
  if (err instanceof Error) return err.message;
  return fallback ?? messages.consumerPhase.error;
}

/** Catalog message for a status error code, or undefined when there is no code. */
export function formatMistaiCode(
  code: MistaiErrorCode | undefined,
  messages: MistaiMessages,
): string | undefined {
  return code ? messages.errors[code] : undefined;
}

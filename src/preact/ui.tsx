// Shared LLM Network status UI, extracted from tc-translate's
// NetworkStatusPanel (which tc-pdf-viewer had duplicated with drifted
// wording) so every app renders the same connection UI.
//
// Styling: class names are `mistai-` prefixed; import the default stylesheet
// via `@tik-choco/mistai/ui.css`. It reads `--mistai-*` custom properties
// (border, surface, text, text-muted, text-strong) with sensible fallbacks,
// so apps theme it by mapping their own variables onto those.
//
// Wording comes from a MistaiMessages catalog (default MESSAGES_EN; pass
// MESSAGES_JA or your own for other languages).

import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ConsumerStatus } from "../client.js";
import type { ProviderLogEntry } from "../provider.js";
import { MESSAGES_EN, formatMistaiCode, type MistaiMessages } from "../messages.js";

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

const CONSUMER_STEP_PHASES = ["idle", "joining", "searching", "connected"] as const;

function consumerStepIndex(phase: ConsumerStatus["phase"]): number {
  if (phase === "error") return -1;
  return CONSUMER_STEP_PHASES.indexOf(phase as (typeof CONSUMER_STEP_PHASES)[number]);
}

/** Localized message for an error-phase status: catalog code first, raw message as fallback. */
export function consumerErrorText(status: ConsumerStatus, messages: MistaiMessages): string | null {
  if (status.phase !== "error") return null;
  return formatMistaiCode(status.code, messages) ?? status.message;
}

export interface ConsumerStatusIndicatorProps {
  status: ConsumerStatus;
  messages?: MistaiMessages;
  /** Timestamp (ms) of the last phase transition; shown as "· HH:MM:SS" next to the status. */
  updatedAt?: number;
  /**
   * 'compact' (default): icon + short status word only, for topbars where
   * space is tight and the detail is one click away.
   * 'detailed': folds the provider id into the summary line itself and shows
   * the step indicator in the expanded detail, for settings cards.
   */
  variant?: "compact" | "detailed";
  /** Optional extra line shown in the detail while not yet connected. */
  note?: string;
}

/**
 * Compact, expandable indicator for the consumer's LLM Network connection
 * state: colored dot + status label, with a click-to-open popover showing the
 * step progression (idle → joining → searching → connected) and errors.
 */
export function ConsumerStatusIndicator({
  status,
  messages = MESSAGES_EN,
  updatedAt,
  variant = "compact",
  note,
}: ConsumerStatusIndicatorProps) {
  const [expanded, setExpanded] = useState(false);

  const baseLabel = messages.consumerPhase[status.phase];
  const label =
    variant === "detailed" && status.phase === "connected"
      ? `${baseLabel} (provider: ${status.providerId.slice(0, 8)}…)`
      : baseLabel;
  const stepIndex = consumerStepIndex(status.phase);

  return (
    <div class="mistai-consumer-indicator">
      <button
        type="button"
        class="mistai-consumer-indicator-toggle"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        title={messages.ui.connectionTitle}
      >
        <span class={`mistai-status-dot ${status.phase}`} />
        <span class="mistai-consumer-indicator-label">{label}</span>
        {updatedAt ? <span class="mistai-status-timestamp">· {formatTime(updatedAt)}</span> : null}
      </button>
      {expanded ? (
        <div class="mistai-consumer-indicator-detail">
          {variant === "detailed" ? (
            <ConsumerStepIndicator status={status} messages={messages} />
          ) : null}
          {status.phase === "connected" && variant !== "detailed" ? (
            <p>provider: {status.providerId.slice(0, 8)}</p>
          ) : null}
          {status.phase === "error" ? <p class="error">{consumerErrorText(status, messages)}</p> : null}
          {note && (status.phase === "idle" || status.phase === "joining" || status.phase === "searching") ? (
            <p>{note}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Standalone step-progression row (未接続 → Room接続中 → …) for layouts that
 * render the steps inline instead of inside the indicator popover.
 */
export function ConsumerStepIndicator(props: { status: ConsumerStatus; messages?: MistaiMessages }) {
  const messages = props.messages ?? MESSAGES_EN;
  const index = consumerStepIndex(props.status.phase);
  return (
    <ol class="mistai-step-indicator">
      {CONSUMER_STEP_PHASES.map((phase, i) => (
        <li
          key={phase}
          class={props.status.phase === "error" ? "" : i < index ? "done" : i === index ? "current" : ""}
        >
          {messages.consumerStep[phase]}
        </li>
      ))}
    </ol>
  );
}

export type ProviderPanelStatus = "idle" | "connecting" | "connected" | "error";

export interface ProviderPeerInfo {
  nodeId: string;
  connectedAt: number;
  isConsumer: boolean;
}

export interface ProviderStatusPanelProps {
  status: ProviderPanelStatus;
  messages?: MistaiMessages;
  /** Timestamp (ms) of the last status transition; shown as "· HH:MM:SS" in the summary line. */
  statusUpdatedAt?: number;
  errorMessage?: string | null;
  ownNodeId?: string | null;
  peers: ProviderPeerInfo[];
  consumerCount: number;
  logs: ProviderLogEntry[];
  /** App-specific notice (e.g. "configure a base URL/model to serve"), rendered under the summary. */
  notice?: ComponentChildren;
  /** Log entries shown before the "show more" button. Defaults to 5. */
  logPageSize?: number;
}

/**
 * Provider operating status: summary line with peer/request counts, an
 * app-supplied notice slot, and a collapsible detail section (own node id,
 * peer list, request log with paging).
 */
export function ProviderStatusPanel({
  status,
  messages = MESSAGES_EN,
  statusUpdatedAt,
  errorMessage,
  ownNodeId,
  peers,
  consumerCount,
  logs,
  notice,
  logPageSize = 5,
}: ProviderStatusPanelProps) {
  const [logLimit, setLogLimit] = useState(logPageSize);
  const visibleLogs = logs.slice(0, logLimit);

  const summaryLine =
    status === "connected"
      ? `${messages.providerStatus.connected} · ${messages.ui.connectedSummary(peers.length, logs.length)}`
      : messages.providerStatus[status];

  return (
    <div class="mistai-status-panel">
      <div class="mistai-status-line">
        <span class={`mistai-status-dot ${status}`} />
        <span>{summaryLine}</span>
        {statusUpdatedAt ? <span class="mistai-status-timestamp">· {formatTime(statusUpdatedAt)}</span> : null}
      </div>
      {notice}
      {status === "error" && errorMessage ? <p class="mistai-status-detail error">{errorMessage}</p> : null}
      {status !== "idle" ? (
        <details class="mistai-status-details">
          <summary>{messages.ui.details}</summary>
          <p class="mistai-status-detail">
            {messages.ui.nodeId}: {(ownNodeId ?? "").slice(0, 8)}
          </p>
          <p class="mistai-status-detail">{messages.ui.peersLine(peers.length, consumerCount)}</p>
          {peers.length > 0 ? (
            <ul class="mistai-peer-list">
              {peers.map((peer) => (
                <li key={peer.nodeId}>
                  {peer.nodeId.slice(0, 8)}
                  {peer.isConsumer ? " (consumer)" : ""} — {formatTime(peer.connectedAt)}
                </li>
              ))}
            </ul>
          ) : null}

          <h4>{messages.ui.requestLog}</h4>
          {logs.length === 0 ? (
            <p class="mistai-hint">{messages.ui.noRequests}</p>
          ) : (
            <>
              <ul class="mistai-log-list">
                {visibleLogs.map((entry) => (
                  <li
                    key={entry.id}
                    title={`from ${entry.fromId.slice(0, 8)}${entry.model ? ` · ${entry.model}` : ""}${
                      entry.detail ? ` — ${entry.detail}` : ""
                    }`}
                  >
                    <span class={`mistai-log-badge ${entry.status}`}>{messages.logStatus[entry.status]}</span>
                    <span class="mistai-log-meta">
                      {formatTime(entry.startedAt)} · {messages.ui.charCount(entry.charCount)}
                    </span>
                  </li>
                ))}
              </ul>
              {logs.length > logLimit ? (
                <button type="button" class="mistai-log-more" onClick={() => setLogLimit((current) => current + 10)}>
                  {messages.ui.showMore(logs.length - logLimit)}
                </button>
              ) : null}
            </>
          )}
        </details>
      ) : null}
    </div>
  );
}

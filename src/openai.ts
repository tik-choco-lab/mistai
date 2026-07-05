// Minimal OpenAI-compatible chat completions client. Streams via SSE when
// possible, falling back to a single non-streaming response if the server
// doesn't return an event-stream body.
//
// Unified from tc-mistllm/src/lib/openai.ts (callOpenAI/fetchModels) and
// tc-translate/src/lib/llm.ts (temperature / reasoning_effort support).

import type { ChatMessage } from "./protocol.js";
import { MistaiError } from "./errors.js";

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string;
  model?: string;
  temperature?: number;
  reasoningEffort?: string;
}

export type FetchFn = typeof fetch;

/**
 * Calls {baseUrl}/chat/completions with the given messages. `onDelta` is
 * invoked for each streamed content fragment. Resolves with the full
 * assembled content once the response completes.
 */
export async function streamChatCompletion(
  config: OpenAIConfig,
  messages: ChatMessage[],
  onDelta?: (delta: string) => void,
  fetchFn: FetchFn = fetch,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.reasoningEffort !== undefined ? { reasoning_effort: config.reasoningEffort } : {}),
      }),
    });
  } catch (err) {
    throw new MistaiError("UPSTREAM_REQUEST_FAILED", `LLM API request failed: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new MistaiError("UPSTREAM_HTTP_ERROR", `LLM API returned an error (${response.status}): ${bodyText.slice(0, 500)}`, {
      status: response.status,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    return streamSse(response.body, onDelta);
  }

  const json = await response.json().catch(() => null);
  const content = (json as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message
    ?.content;
  if (typeof content !== "string") {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", "LLM API returned a response with an unexpected format");
  }
  onDelta?.(content);
  return content;
}

/**
 * Fetches the list of available model ids from {baseUrl}/models. Validates
 * that the response has the expected `{ data: [{ id: string }, ...] }`
 * shape and throws a clear error otherwise.
 */
export async function fetchModels(
  config: Pick<OpenAIConfig, "baseUrl" | "apiKey">,
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
  } catch (err) {
    throw new MistaiError("UPSTREAM_REQUEST_FAILED", `Failed to fetch the model list: ${(err as Error).message}`);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new MistaiError("UPSTREAM_HTTP_ERROR", `Model list request returned an error (${response.status}): ${bodyText.slice(0, 500)}`, {
      status: response.status,
    });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", "Model list response is not valid JSON");
  }

  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    throw new MistaiError("UPSTREAM_BAD_RESPONSE", "Model list response had an unexpected format");
  }

  const ids = data
    .map((entry) => (typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  if (ids.length === 0) {
    throw new MistaiError("MODEL_LIST_EMPTY", "Model list was empty or could not be parsed");
  }

  return ids;
}

async function streamSse(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice("data:".length).trim();
      if (data === "[DONE]") continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue; // Ignore malformed SSE lines (e.g. keep-alive comments).
      }
      const delta = (parsed as { choices?: { delta?: { content?: string } }[] })?.choices?.[0]
        ?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) {
        full += delta;
        onDelta?.(delta);
      }
    }
  }

  return full;
}

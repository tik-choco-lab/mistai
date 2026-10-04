// Ported from tc-translate/lib/providerModels.ts: SWR, dedupe and connection guards.
import { fetchModels } from './openai.js';
import { loadLlmConfig, saveLlmConfig, normalizeBaseUrl, isNetworkProviderBaseUrl, roomIdFromBaseUrl, type LlmProviderV1, type SharedLlmConfigV1 } from './llm-config.js';
import { MistaiError } from './errors.js';
import { roomConsumer } from './rooms.js';

export type ModelFetchStatus = { phase: 'fetching' | 'ok' | 'error'; error?: string };
const statuses = new Map<string, { connection: string; status: ModelFetchStatus }>();
const inFlight = new Map<string, { connection: string; promise: Promise<void> }>();
const listeners = new Set<() => void>();
const connectionKey = (p: LlmProviderV1) => JSON.stringify([p.baseUrl, p.apiKey, p.enabled !== false]);
export function modelFetchStatus(input: string | LlmProviderV1): ModelFetchStatus | undefined {
  const provider = typeof input === 'string' ? loadLlmConfig()?.providers.find(p => p.id === input) : input;
  if (!provider) return undefined;
  const entry = statuses.get(provider.id);
  return entry?.connection === connectionKey(provider) ? entry.status : undefined;
}
export function subscribeModelFetchStatus(cb: () => void): () => void { listeners.add(cb); return () => { listeners.delete(cb); }; }
function setStatus(p: LlmProviderV1, status: ModelFetchStatus) { statuses.set(p.id, { connection: connectionKey(p), status }); listeners.forEach(cb => cb()); }
function currentProvider(p: LlmProviderV1) {
  const current = loadLlmConfig()?.providers.find(value => value.id === p.id);
  return current && current.enabled !== false && connectionKey(current) === connectionKey(p) ? current : undefined;
}
export function cacheRoomModels(room: string, models: string[]): void {
  const config = loadLlmConfig();
  const providers = config?.providers.filter(p => p.enabled !== false && isNetworkProviderBaseUrl(p.baseUrl) && roomIdFromBaseUrl(p.baseUrl) === room.trim()) ?? [];
  if (!config || !providers.length) return;
  for (const provider of providers) {
    provider.models = [...new Set([...models, ...(provider.models ?? [])])];
    provider.modelsFetchedAt = new Date().toISOString();
    setStatus(provider, { phase: 'ok' });
  }
  saveLlmConfig(config);
}
export function refreshProviderModels(input: string | LlmProviderV1 | SharedLlmConfigV1, options: { force?: boolean } = {}): Promise<void> {
  if (typeof input !== 'string' && 'providers' in input) return Promise.all(input.providers.map(p => refreshProviderModels(p, options))).then(() => {});
  const provider = typeof input === 'string' ? loadLlmConfig()?.providers.find(p => p.id === input) : input;
  if (!provider || provider.enabled === false) return Promise.resolve();
  const id = provider.id, connection = connectionKey(provider);
  const pending = inFlight.get(id);
  if (pending) return pending.connection === connection ? pending.promise : pending.promise.then(() => refreshProviderModels(id, { force: true }));
  if (!options.force && Date.now() - Date.parse(provider.modelsFetchedAt ?? '') < 10_000) return Promise.resolve();
  // Start on a microtask so the map is populated even when a fetch throws synchronously.
  const promise = Promise.resolve().then(async () => {
    setStatus(provider, { phase: 'fetching' });
    try {
      let models: string[];
      if (isNetworkProviderBaseUrl(provider.baseUrl)) {
        const client = roomConsumer(roomIdFromBaseUrl(provider.baseUrl));
        await client.connect(roomIdFromBaseUrl(provider.baseUrl));
        const status = client.status;
        if (status.phase === 'error') throw new Error(status.message);
        if (status.phase === 'idle') return;
        models = [...new Set([...(status.phase === 'connected' ? status.models ?? [] : []), ...(currentProvider(provider)?.models ?? [])])];
      } else {
        try {
          models = [...new Set(await fetchModels({ ...provider, baseUrl: normalizeBaseUrl(provider.baseUrl) }, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })))].sort((a, b) => a.localeCompare(b));
        } catch (error) {
          if (error instanceof MistaiError && error.code === 'MODEL_LIST_EMPTY') models = [];
          else throw error;
        }
      }
      if (!currentProvider(provider)) return;
      const config = loadLlmConfig()!;
      const current = config.providers.find(p => p.id === id)!;
      current.models = models; current.modelsFetchedAt = new Date().toISOString();
      saveLlmConfig(config); setStatus(current, { phase: 'ok' });
    } catch (error) {
      if (currentProvider(provider)) setStatus(provider, { phase: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally { inFlight.delete(id); }
  });
  inFlight.set(id, { connection, promise });
  return promise;
}
export function revalidateProviderModels(): Promise<void> { return Promise.all((loadLlmConfig()?.providers ?? []).map(p => refreshProviderModels(p))).then(() => {}); }

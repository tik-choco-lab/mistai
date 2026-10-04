import { useEffect, useState } from 'preact/hooks';
import { emptyLlmConfig, loadLlmConfig, saveLlmConfig, subscribeLlmConfig, migrateSharedLlmConfig, type SharedLlmConfigV1 } from '../llm-config.js';
import { modelFetchStatus, subscribeModelFetchStatus, revalidateProviderModels, refreshProviderModels } from '../model-catalog.js';
import { roomConsumer } from '../rooms.js';
import type { ConsumerStatus } from '../client.js';
export function useLlmConfig() {
  const [config, setConfig] = useState(() => {
    const value = loadLlmConfig() ?? emptyLlmConfig();
    if (migrateSharedLlmConfig(value).changed) saveLlmConfig(value);
    return value;
  });
  useEffect(() => {
    setConfig(loadLlmConfig() ?? emptyLlmConfig());
    return subscribeLlmConfig(value => setConfig(value ?? emptyLlmConfig()));
  }, []);
  const save = (mutate: (value: SharedLlmConfigV1) => void) => {
    const value = structuredClone(loadLlmConfig() ?? config); mutate(value); saveLlmConfig(value); setConfig(value);
  };
  return { config, save };
}
export function useModelFetchStatus() {
  const [, update] = useState(0);
  useEffect(() => subscribeModelFetchStatus(() => update(n => n + 1)), []);
}
export function useModelCatalog() {
  const { config } = useLlmConfig(); useModelFetchStatus();
  return { providers: config.providers, modelFetchStatus, refreshProviderModels, revalidateProviderModels };
}
export function useNetworkConsumerStatusWithTimestamp(room: string) {
  const [value, setValue] = useState<{ status: ConsumerStatus; updatedAt: number }>({ status: room ? roomConsumer(room).status : { phase: 'idle' }, updatedAt: 0 });
  useEffect(() => {
    if (!room) { setValue({ status: { phase: 'idle' }, updatedAt: 0 }); return; }
    const client = roomConsumer(room); setValue({ status: client.status, updatedAt: Date.now() });
    return client.onStatusChange(status => setValue({ status, updatedAt: Date.now() }));
  }, [room]);
  return value;
}

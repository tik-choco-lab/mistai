import { useEffect, useRef, useState } from 'preact/hooks';
import { RoomProviderService, type RoomProviderOptions, type RoomProviderState } from '../room-provider.js';
import { getRoomConsumers } from '../rooms.js';
import { resolveModelExact, providerKind, roomIdFromBaseUrl, type ModelRefV1 } from '../llm-config.js';
const results = new Map<string, RoomProviderState>();
const listeners = new Set<() => void>();
export interface UseRoomProvidersOptions extends RoomProviderOptions {
  /** App-local task refs; default and voice refs are included automatically. */
  taskRefs?: (ModelRefV1 | undefined)[];
  settingsOpen?: boolean;
}
export function useRoomProviders(options: UseRoomProvidersOptions): Record<string, RoomProviderState> {
  const service = useRef<RoomProviderService>();
  const latest = useRef(options); latest.current = options;
  const [states, setStates] = useState<Record<string, RoomProviderState>>({});
  const owned = useRef<string[]>([]);
  const joined = useRef(new Set<string>());
  useEffect(() => {
    const manager = new RoomProviderService(latest.current); service.current = manager;
    const sync = () => {
      owned.current.forEach(id => results.delete(id));
      const states = manager.states; owned.current = Object.keys(states);
      Object.entries(states).forEach(([id, state]) => results.set(id, state));
      listeners.forEach(fn => fn()); setStates(states);
    };
    sync(); const stop = manager.subscribe(sync);
    return () => { stop(); manager.destroy(); owned.current.forEach(id => results.delete(id)); listeners.forEach(fn => fn()); service.current = undefined; };
  }, [options.consumers]);
  useEffect(() => { service.current?.update(options); }, [options.config, options.roomProvide, options.reasoningEffort, options.maxLogEntries]);
  const refsKey = JSON.stringify(options.taskRefs ?? []);
  useEffect(() => {
    const config = options.config, rooms = options.consumers ?? getRoomConsumers();
    const refs = [config.defaultModel, ...options.taskRefs ?? [], ...(['tts', 'stt'] as const).map(kind => config[kind] ? { providerId: config[kind]!.providerId ?? config.defaultModel?.providerId ?? '', model: config[kind]!.model } : undefined)];
    const referenced = new Set(refs.map(ref => resolveModelExact(config, ref)).filter(target => target && providerKind(target) === 'room').map(target => target!.providerId));
    const wanted = new Set<string>();
    for (const provider of config.providers.filter(p => providerKind(p) === 'room')) {
      const room = roomIdFromBaseUrl(provider.baseUrl);
      if (room && provider.enabled !== false && (referenced.has(provider.id) || options.roomProvide[provider.id]?.enabled || options.settingsOpen)) { wanted.add(room); void rooms.roomConsumer(room).connect(room); }
    }
    // Release only memberships acquired by this hook. An unselected room
    // may still have an on-demand consumer with an active request.
    for (const room of joined.current) if (!wanted.has(room)) rooms.disconnectRoom(room);
    joined.current = wanted;
  }, [options.config, options.roomProvide, options.consumers, options.settingsOpen, refsKey]);
  useEffect(() => {
    const rooms = options.consumers ?? getRoomConsumers();
    return () => { joined.current.forEach(room => rooms.disconnectRoom(room)); joined.current.clear(); };
  }, [options.consumers]);
  return states;
}
export function useRoomProviderResult(id: string) {
  const [, update] = useState(0);
  useEffect(() => { const fn = () => update(n => n + 1); listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  return results.get(id);
}

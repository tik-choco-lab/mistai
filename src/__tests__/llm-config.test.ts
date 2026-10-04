import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LLM_CONFIG_KEY, emptyLlmConfig, createProvider, createRoomProvider, patchProvider, deleteProvider, setDefaultModel, setVoiceConfig, resolveModel, resolveModelExact, resolveVoice, providerKind, isModelRef, networkProviderBaseUrl, roomIdFromBaseUrl, networkVoiceModelParam, loadLlmConfig, saveLlmConfig, subscribeLlmConfig, migrateSharedLlmConfig, presetIdToRef } from '../llm-config.js';
function storage() { const map = new Map<string,string>(); return { getItem: (key:string) => map.get(key) ?? null, setItem: (key:string,value:string) => map.set(key,value), removeItem: (key:string) => map.delete(key) }; }
beforeEach(() => vi.stubGlobal('localStorage', storage()));
afterEach(() => vi.unstubAllGlobals());
function setup() { const config = emptyLlmConfig(), id = createProvider(config,'Endpoint'); patchProvider(config,id,{baseUrl:'https://example.test/v1',apiKey:'secret'}); return {config,id}; }
describe('v1 additions and resolution', () => {
  it('roundtrips caches, voice, enabled and defaultModel with legacy fields intact', () => {
    const {config,id} = setup(); config.presets=[{id:'old',label:'Old',providerId:id,model:'raw',temperature:.8,reasoningEffort:'high'}]; config.defaultPresetId='old'; config.network={roomId:'legacy-room'};
    patchProvider(config,id,{enabled:false,models:['raw'],modelsFetchedAt:'2026-01-01T00:00:00Z'}); setDefaultModel(config,{providerId:id,model:'raw'}); config.tts={providerId:id,model:'speech',speed:1.4};
    const legacy=JSON.stringify([config.presets,config.defaultPresetId,config.network]); saveLlmConfig(config); const loaded=loadLlmConfig()!;
    expect(loaded.providers[0]).toEqual(config.providers[0]); expect(loaded.defaultModel).toEqual(config.defaultModel); expect(loaded.tts).toEqual(config.tts); expect(JSON.stringify([loaded.presets,loaded.defaultPresetId,loaded.network])).toBe(legacy);
  });
  it('uses only the default fallback, never mutates refs and recovers on re-enable', () => {
    const {config,id}=setup(); const other=createProvider(config,'Other'); patchProvider(config,other,{baseUrl:'https://other.test',enabled:false}); const ref={providerId:other,model:'kept'};
    setDefaultModel(config,{providerId:id,model:'default'}); expect(resolveModel(config,ref)?.model).toBe('default'); expect(resolveModelExact(config,ref)).toBeNull(); expect(ref.model).toBe('kept');
    patchProvider(config,other,{enabled:true}); expect(resolveModel(config,ref)?.model).toBe('kept'); setDefaultModel(config); patchProvider(config,other,{enabled:false}); expect(resolveModel(config,ref)).toBeNull(); expect(resolveModel(config)).toBeNull();
  });
  it('rejects blank models, disabled providers, blank endpoints and missing providers', () => {
    const {config,id}=setup(); for(const ref of [{providerId:id,model:' '},{providerId:'missing',model:'raw'}]) expect(resolveModelExact(config,ref)).toBeNull(); patchProvider(config,id,{baseUrl:''}); expect(resolveModelExact(config,{providerId:id,model:'raw'})).toBeNull();
    expect(isModelRef({providerId:id,model:'raw'})).toBe(true); expect(isModelRef(null)).toBe(false); expect(isModelRef({providerId:3,model:'raw'})).toBe(false);
  });
  it('clears voice to browser, preserves independently saved speed and resolves inherited provider', () => {
    const {config,id}=setup(); setDefaultModel(config,{providerId:id,model:'chat'}); config.tts={model:'speech',speed:1.2}; setVoiceConfig(config,'tts',{model:'speech',voice:'speaker'}); expect(resolveVoice(config,'tts')).toMatchObject({providerId:id,model:'speech',voice:'speaker',speed:1.2});
    setVoiceConfig(config,'tts',{model:''}); expect(resolveVoice(config,'tts')).toBeNull(); expect(config.tts?.speed).toBe(1.2);
  });
  it('room CRUD dedupes and leaves references unchanged on delete', () => {
    const {config,id}=setup(); const first=createRoomProvider(config,{roomId:' team ',label:'Team'}); expect(first.existed).toBe(false); expect(createRoomProvider(config,{roomId:'team'})).toEqual({id:first.id,existed:true}); expect(config.providers).toHaveLength(2); expect(providerKind(config.providers[1])).toBe('room'); expect(roomIdFromBaseUrl(networkProviderBaseUrl(' team '))).toBe('team'); expect(networkVoiceModelParam('network-auto')).toBeUndefined(); expect(networkVoiceModelParam(' raw ')).toBe('raw');
    expect(()=>createRoomProvider(config,{roomId:' '})).toThrow(); setDefaultModel(config,{providerId:id,model:'kept'}); deleteProvider(config,id); expect(config.defaultModel?.providerId).toBe(id); expect(resolveModel(config)).toBeNull();
  });
  it('defensively loads malformed data and works when storage is unavailable', () => {
    for(const raw of ['bad','null','{}','{"v":2}']) { localStorage.setItem(LLM_CONFIG_KEY,raw); expect(loadLlmConfig()).toBeNull(); }
    const {config}=setup(); localStorage.setItem(LLM_CONFIG_KEY,JSON.stringify({...config,providers:[...config.providers,{id:2}],defaultModel:{model:3},tts:{model:3}})); expect(loadLlmConfig()?.providers).toHaveLength(1); expect(loadLlmConfig()?.defaultModel).toBeUndefined(); expect(loadLlmConfig()?.tts).toBeUndefined();
  });
  it('notifies same-tab saves and supports unsubscribe', () => {
    const cb=vi.fn(), stop=subscribeLlmConfig(cb); saveLlmConfig(emptyLlmConfig()); expect(cb).toHaveBeenCalledTimes(1); stop(); saveLlmConfig(emptyLlmConfig()); expect(cb).toHaveBeenCalledTimes(1);
  });
});
describe('migration',()=>{
  it('ports default, room and manual preset models once, retaining all legacy data',()=>{
    const {config,id}=setup(); const room=createRoomProvider(config,{roomId:'mirrored'}); config.presets=[{id:'old',label:'Custom label',providerId:id,model:'raw',reasoningEffort:'high'},{id:'mirror',label:'Mirror',providerId:room.id,model:'room-model'}];config.defaultPresetId='old';config.network.roomId='old-room';
    const legacy=JSON.stringify([config.presets,config.defaultPresetId,config.network]); expect(migrateSharedLlmConfig(config)).toEqual({changed:true}); expect(config.defaultModel).toEqual({providerId:id,model:'raw'}); expect(config.providers[0].models).toEqual(['raw']); expect(config.providers).toHaveLength(3); expect(config.providers[1].models).toEqual([]); expect(presetIdToRef(config,'mirror')).toBeUndefined(); expect(presetIdToRef(config,'old')).toEqual(config.defaultModel); expect(migrateSharedLlmConfig(config)).toEqual({changed:false}); expect(JSON.stringify([config.presets,config.defaultPresetId,config.network])).toBe(legacy);
  });
  it('does not overwrite new default or reseed a live fetched cache',()=>{
    const {config,id}=setup(); config.defaultModel={providerId:id,model:'new'};config.presets=[{id:'old',label:'Old',providerId:id,model:'retired'}];config.defaultPresetId='old';patchProvider(config,id,{models:['live'],modelsFetchedAt:new Date().toISOString()}); expect(migrateSharedLlmConfig(config).changed).toBe(false); expect(config.defaultModel.model).toBe('new');expect(config.providers[0].models).toEqual(['live']);
  });
});

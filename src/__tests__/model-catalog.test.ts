import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { emptyLlmConfig, createProvider, patchProvider, createRoomProvider, saveLlmConfig, loadLlmConfig } from '../llm-config.js';
import { refreshProviderModels, revalidateProviderModels, modelFetchStatus, subscribeModelFetchStatus, cacheRoomModels } from '../model-catalog.js';
beforeEach(()=>{const values=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v)});});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
function provider(){const config=emptyLlmConfig(),id=createProvider(config,'Endpoint');patchProvider(config,id,{baseUrl:'https://example.test',models:['cache']});saveLlmConfig(config);return id;}
it('dedupes concurrent requests, throttles success for 10 seconds, and force bypasses throttle',async()=>{
  vi.useFakeTimers();const id=provider();let release!:(r:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(resolve=>{release=resolve;}));vi.stubGlobal('fetch',fetch);const cb=vi.fn(),stop=subscribeModelFetchStatus(cb);
  const a=refreshProviderModels(id),b=refreshProviderModels(id);expect(a).toBe(b);await Promise.resolve();expect(fetch).toHaveBeenCalledTimes(1);expect(modelFetchStatus(id)?.phase).toBe('fetching');release(new Response(JSON.stringify({data:[{id:'raw'},{id:'raw'}]})));await a;expect(loadLlmConfig()?.providers[0].models).toEqual(['raw']);expect(modelFetchStatus(id)?.phase).toBe('ok');await refreshProviderModels(id);expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockImplementation(async()=>new Response(JSON.stringify({data:[{id:'next'}]})));await refreshProviderModels(id,{force:true});expect(fetch).toHaveBeenCalledTimes(2);vi.advanceTimersByTime(10_001);await revalidateProviderModels();expect(fetch).toHaveBeenCalledTimes(3);expect(cb).toHaveBeenCalled();stop();
});
it('never fetches disabled providers; failure retains cache and permits retry',async()=>{
  const id=provider();const config=loadLlmConfig()!;patchProvider(config,id,{enabled:false});saveLlmConfig(config);const fetch=vi.fn(async()=>{throw new Error('offline');});vi.stubGlobal('fetch',fetch);await revalidateProviderModels();await refreshProviderModels(id,{force:true});expect(fetch).not.toHaveBeenCalled();patchProvider(config,id,{enabled:true});saveLlmConfig(config);await refreshProviderModels(id);expect(modelFetchStatus(id)).toEqual({phase:'error',error:expect.stringContaining('offline')});expect(loadLlmConfig()?.providers[0].models).toEqual(['cache']);await refreshProviderModels(id);expect(fetch).toHaveBeenCalledTimes(2);
});
it('ignores superseded connection responses and queues exactly one new fetch',async()=>{
  const id=provider();let release!:(r:Response)=>void;const fetch=vi.fn(()=>new Promise<Response>(r=>{release=r;}));vi.stubGlobal('fetch',fetch);const a=refreshProviderModels(id);await Promise.resolve();const config=loadLlmConfig()!;patchProvider(config,id,{baseUrl:'https://new.test'});saveLlmConfig(config);const b=refreshProviderModels(id);release(new Response(JSON.stringify({data:[{id:'stale'}]})));await a;await Promise.resolve();expect(loadLlmConfig()?.providers[0].models).toEqual(['cache']);release(new Response(JSON.stringify({data:[{id:'new'}]})));await b;expect(fetch).toHaveBeenCalledTimes(2);expect(loadLlmConfig()?.providers[0].models).toEqual(['new']);
});
it('room hellos merge only that enabled room cache without creating presets',()=>{
  const config=emptyLlmConfig(),a=createRoomProvider(config,{roomId:'a'}),b=createRoomProvider(config,{roomId:'b'});patchProvider(config,a.id,{models:['cached']});patchProvider(config,b.id,{enabled:false});saveLlmConfig(config);cacheRoomModels('a',['live','live']);cacheRoomModels('b',['ignored']);const loaded=loadLlmConfig()!;expect(loaded.providers[0].models).toEqual(['live','cached']);expect(loaded.providers[1].models).toEqual([]);expect(loaded.presets).toEqual([]);
});
it('ports HTTP catalog sorting and treats a valid empty list as successful discovery',async()=>{
  const id=provider(),fetch=vi.fn(async()=>new Response(JSON.stringify({data:[{id:'z'},{id:'a'},{id:'z'}]})));vi.stubGlobal('fetch',fetch);await refreshProviderModels(id);expect(loadLlmConfig()?.providers[0].models).toEqual(['a','z']);fetch.mockImplementation(async()=>new Response(JSON.stringify({data:[]})));await refreshProviderModels(id,{force:true});expect(loadLlmConfig()?.providers[0].models).toEqual([]);expect(modelFetchStatus(id)?.phase).toBe('ok');
});

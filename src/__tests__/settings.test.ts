// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { ModelPicker, matchesModelQuery } from '../preact/ModelPicker.js';
import { LlmSettings, buildTtsVoiceOptionValues, resolveTtsVoiceOptions } from '../preact/settings.js';
import { emptyLlmConfig, createProvider, patchProvider, createRoomProvider, saveLlmConfig } from '../llm-config.js';
import { createRoomConsumers } from '../rooms.js';
import { createSharedNodeScope } from '../shared-node.js';
import { FakeMistNode } from './fake-node.js';
let container: HTMLDivElement;
beforeEach(()=>{
  localStorage.clear();container=document.createElement('div');document.body.append(container);createRoomConsumers(createSharedNodeScope(id=>new FakeMistNode(id)));
  vi.stubGlobal('matchMedia',()=>({matches:true,addEventListener(){},removeEventListener(){}}));
  vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
  HTMLElement.prototype.scrollIntoView=()=>{};
});
afterEach(()=>{act(()=>render(null,container));container.remove();document.querySelectorAll('.model-picker-overlay').forEach(n=>n.remove());vi.unstubAllGlobals();});
const click=(selector:string)=>act(()=>{const element=document.querySelector<HTMLButtonElement>(selector);expect(element,selector).not.toBeNull();element!.click();});
function setup(){const config=emptyLlmConfig(),a=createProvider(config,'Alpha endpoint'),b=createProvider(config,'Disabled endpoint'),room=createRoomProvider(config,{roomId:'team',label:'Team'});patchProvider(config,a,{baseUrl:'https://a.test',models:['gem-raw',...Array.from({length:300},(_,i)=>`model-${i}`)],modelsFetchedAt:new Date().toISOString()});patchProvider(config,b,{baseUrl:'https://b.test',enabled:false,models:['disabled']});patchProvider(config,room.id,{models:['gem-raw'],modelsFetchedAt:new Date().toISOString()});config.defaultModel={providerId:a,model:'gem-raw'};saveLlmConfig(config);return {config,a,b,room};}
it('two-pane picker renders every (provider, model) once, with assigned provider selected',()=>{
  const {config,a}=setup(),assigned=config.defaultModel!;act(()=>render(h(ModelPicker,{providers:config.providers,value:assigned,recent:[assigned,assigned],label:'Pick',onChange:()=>{}}),container));click('.model-picker-trigger');expect(document.querySelector('.model-source[aria-selected="true"]')?.getAttribute('data-source-id')).toBe(a);expect(document.querySelectorAll('[data-model="gem-raw"]')).toHaveLength(1);expect(document.querySelectorAll('[data-model]')).toHaveLength(301);expect(document.querySelector('[data-source-id]')?.textContent).toContain('Recent');click('[data-source-id="recent"]');expect(document.querySelectorAll('[data-model]')).toHaveLength(1);expect(document.querySelector('.model-row-provider')?.textContent).toBe('Alpha endpoint');expect(document.querySelector('[data-model="disabled"]')).toBeNull();
});
it('AND search spans all providers, narrowing and clearing restores the original source; no manual row',()=>{
  const {config,a,room}=setup();act(()=>render(h(ModelPicker,{providers:config.providers,value:config.defaultModel,recent:[config.defaultModel!],label:'Pick',onChange:()=>{}}),container));click('.model-picker-trigger');const input=document.querySelector<HTMLInputElement>('.model-picker-menu input')!;
  const query=(value:string)=>act(()=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));});query('gem');expect(document.querySelectorAll('[data-model="gem-raw"]')).toHaveLength(2);expect(document.querySelectorAll('.model-row-provider')).toHaveLength(0);click(`[data-source-id="${room.id}"]`);expect(document.querySelectorAll('[data-model]')).toHaveLength(1);query('');expect(document.querySelector('.model-source[aria-selected="true"]')?.getAttribute('data-source-id')).toBe(a);query('alpha gem');expect(document.querySelectorAll('[data-model]')).toHaveLength(1);query('missing');expect(document.querySelectorAll('[data-model]')).toHaveLength(0);expect(document.body.textContent).not.toMatch(/manually|Use.*missing/);expect(matchesModelQuery({providerId:a,model:'gem-raw'},config.providers[0],'GEM alpha')).toBe(true);
});
it('voice room auto sentinel stays out of chat recents; browser clear applies immediately',()=>{
  const {config,room}=setup(),ref={providerId:room.id,model:'network-auto'},choose=vi.fn();act(()=>render(h(ModelPicker,{providers:config.providers,value:ref,recent:[ref],voice:true,clearLabel:'Browser',label:'Voice',onChange:choose}),container));click('.model-picker-trigger');expect(document.querySelector('[data-model="network-auto"]')).not.toBeNull();click('[data-source-id="clear"]');expect(choose).toHaveBeenCalledWith(undefined);expect(document.querySelector('.model-picker-menu')).toBeNull();act(()=>render(h(ModelPicker,{providers:config.providers,recent:[ref],label:'Chat',onChange:choose}),container));click('.model-picker-trigger');expect(document.querySelector('[data-model="network-auto"]')).toBeNull();
});
it('search Down/Enter selects, Escape closes and restores trigger focus',()=>{
  const {config}=setup(),choose=vi.fn();act(()=>render(h(ModelPicker,{providers:config.providers,value:config.defaultModel,recent:[],label:'Pick',onChange:choose}),container));click('.model-picker-trigger');const input=document.querySelector('input')!;act(()=>{input.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));});act(()=>{document.querySelector('.model-picker-results')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));});expect(choose).toHaveBeenCalledWith(config.defaultModel);expect(document.activeElement?.className).toContain('model-picker-trigger');click('.model-picker-trigger');act(()=>{document.querySelector('.model-picker-menu')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});expect(document.querySelector('.model-picker-menu')).toBeNull();
});
it('three tabs mount app-defined tasks, reasoning, voice and mic adapters',()=>{
  setup();let local={tasks:{summarize:{reasoningEffort:'none' as const}},roomProvide:{},recentModels:[]};act(()=>render(h(LlmSettings,{tasks:[{id:'summarize',label:'Summarize',reasoning:true}],localSettings:{get:()=>local,set:next=>{local=next as typeof local;}},voice:{tts:{},stt:{}},mic:{deviceId:'',onChange:()=>{}},locale:'ja'}),container));expect(document.querySelectorAll('[role="tab"]')).toHaveLength(3);click('[role="tab"]:nth-of-type(2)');expect(document.querySelector('[data-picker-name="summarize"]')).not.toBeNull();click('.reasoning-trigger');expect(document.querySelectorAll('.reasoning-option')).toHaveLength(7);click('[data-value="max"]');expect(local.tasks.summarize.reasoningEffort).toBe('max');expect(document.querySelector('.mic-picker')).not.toBeNull();
});
it('inline fields commit on blur, Escape reverts, and invalid endpoints stay unsaved',()=>{
  const {a}=setup();const local={tasks:{},roomProvide:{},recentModels:[]};act(()=>render(h(LlmSettings,{tasks:[],localSettings:{get:()=>local,set:()=>{}},locale:'en'}),container));click(`[data-provider-id="${a}"] .provider-card-summary`);const inputs=document.querySelectorAll<HTMLInputElement>('.provider-card-body input');act(()=>{inputs[0].value='Renamed';inputs[0].dispatchEvent(new Event('input',{bubbles:true}));inputs[0].focus();inputs[0].blur();});expect(document.querySelector('.provider-card-summary strong')?.textContent).toBe('Renamed');act(()=>{inputs[0].value='Discard';inputs[0].dispatchEvent(new Event('input',{bubbles:true}));inputs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});expect(document.querySelector('.provider-card-summary strong')?.textContent).toBe('Renamed');act(()=>{inputs[1].value='invalid';inputs[1].dispatchEvent(new Event('input',{bubbles:true}));inputs[1].focus();inputs[1].blur();});expect(document.querySelector('.provider-field input[aria-invalid="true"]')).not.toBeNull();
});
it('add popup validates URL and duplicate room, offers existing room and keeps name when toggled',()=>{
  setup();const local={tasks:{},roomProvide:{},recentModels:[]};act(()=>render(h(LlmSettings,{tasks:[],localSettings:{get:()=>local,set:()=>{}},locale:'en'}),container));click('.connection-add-button');const name=document.querySelector<HTMLInputElement>('.connection-name')!;act(()=>{name.value='Kept name';name.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});expect(document.querySelector('.connection-popup [role="alert"]')?.textContent).toContain('HTTP');click('.connection-kind-toggle [role="tab"]:nth-of-type(2)');expect(document.querySelector<HTMLInputElement>('.connection-name')?.value).toBe('Kept name');act(()=>{const input=document.querySelector<HTMLInputElement>('.connection-room-id')!;input.value='team';input.dispatchEvent(new Event('input',{bubbles:true}));});act(()=>{document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});expect(document.querySelector('.connection-use-existing')).not.toBeNull();expect(document.querySelectorAll('.provider-card')).toHaveLength(3);click('.connection-use-existing');expect(document.querySelector('.connection-popup')).toBeNull();
});
it('press originating in a popup cannot dismiss settings when released on the backdrop',()=>{
  setup();const close=vi.fn(),local={tasks:{},roomProvide:{},recentModels:[]};act(()=>render(h(LlmSettings,{tasks:[],localSettings:{get:()=>local,set:()=>{}},onClose:close}),container));click('.connection-add-button');const popup=document.querySelector('.connection-popup')!,layer=document.querySelector('.mistai-settings-layer')!;act(()=>{popup.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));layer.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(close).not.toHaveBeenCalled();expect(document.querySelector('.connection-popup')).not.toBeNull();act(()=>{layer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));layer.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(close).toHaveBeenCalledTimes(1);
});
it('voice options retain configured values and network uses only advertised voices',()=>{
  expect(buildTtsVoiceOptionValues(['voice-a'],'saved')).toEqual(['','saved','voice-a']);expect(resolveTtsVoiceOptions({engine:'network',fetchedApiVoices:['http']})).toEqual([]);expect(resolveTtsVoiceOptions({engine:'api',fetchedApiVoices:[],adapterVoiceOptions:['custom']})).toEqual(['custom']);
});

it('Tasks TTS speed is a choice picker persisting to shared config; provider default clears it', () => {
  const { config, a } = setup();
  config.tts = { providerId: a, model: '', voice: 'saved', speed: 1.1 };
  saveLlmConfig(config);
  const local = { tasks: {}, roomProvide: {}, recentModels: [] };
  act(() => render(h(LlmSettings, { tasks: [], initialTab: 'tasks', voice: { tts: {} }, localSettings: { get: () => local, set: () => {} } }), container));
  expect(document.querySelector('[name="tts-speed"]')).toBeNull();
  expect(document.querySelector('.tts-speed-picker .model-trigger-text')?.textContent).toBe('1.1×');
  click('.tts-speed-picker .choice-trigger');
  expect([...document.querySelectorAll('.reasoning-option')].map(o => o.getAttribute('data-value'))).toEqual(['', '0.75', '1', '1.1', '1.25', '1.5', '2']);
  click('.reasoning-option[data-value="2"]');
  expect(JSON.parse(localStorage.getItem('tc-shared-llm-config-v1')!).tts).toEqual({ providerId: a, model: '', voice: 'saved', speed: 2 });
  click('.tts-speed-picker .choice-trigger');
  click('.reasoning-option[data-value=""]');
  expect(JSON.parse(localStorage.getItem('tc-shared-llm-config-v1')!).tts).toEqual({ providerId: a, model: '', voice: 'saved' });
});

it('Tasks TTS speed uses the voice adapter when supplied', () => {
  setup();
  const local = { tasks: {}, roomProvide: {}, recentModels: [] }, set = vi.fn();
  act(() => render(h(LlmSettings, { tasks: [], initialTab: 'tasks', voice: { tts: { get: () => ({ model: '', voice: 'saved', speed: 1.5 }), set } }, localSettings: { get: () => local, set: () => {} } }), container));
  expect(document.querySelector('.tts-speed-picker .model-trigger-text')?.textContent).toBe('1.5×');
  click('.tts-speed-picker .choice-trigger');
  click('.reasoning-option[data-value="0.75"]');
  expect(set).toHaveBeenCalledWith({ model: '', voice: 'saved', speed: 0.75 });
});

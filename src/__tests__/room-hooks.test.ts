// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useRoomProviders } from '../preact/room-providers.js';
import { emptyLlmConfig, createProvider, createRoomProvider, patchProvider } from '../llm-config.js';
import { createRoomConsumers } from '../rooms.js';
import { createSharedNodeScope } from '../shared-node.js';
import { FakeMistNode, flushMicrotasks } from './fake-node.js';
let container:HTMLDivElement;
afterEach(()=>{if(container){act(()=>render(null,container));container.remove();}});
it('joins referenced/providing rooms, discovers other rooms only while open, and releases edits/removals/unmount',async()=>{
  const config=emptyLlmConfig(),http=createProvider(config,'HTTP'),a=createRoomProvider(config,{roomId:'a'}),b=createRoomProvider(config,{roomId:'b'}),c=createRoomProvider(config,{roomId:'c'}),disabled=createRoomProvider(config,{roomId:'disabled'});
  patchProvider(config,http,{baseUrl:'https://upstream.test'});patchProvider(config,disabled.id,{enabled:false});config.defaultModel={providerId:a.id,model:'remote'};
  const node=new FakeMistNode('peer'),consumers=createRoomConsumers(createSharedNodeScope(()=>node));let options={config,consumers,roomProvide:{[b.id]:{enabled:true,shared:[{providerId:http,model:'raw'}]}},settingsOpen:false};
  const Host=()=>{useRoomProviders(options);return null;};container=document.createElement('div');document.body.append(container);
  await act(async()=>{render(h(Host,{}),container);});await flushMicrotasks();expect(node.joinedRooms.sort()).toEqual(['a','b']);
  options={...options,settingsOpen:true};await act(async()=>{render(h(Host,{}),container);});await flushMicrotasks();expect(node.joinedRooms.sort()).toEqual(['a','b','c']);expect(node.joinedRooms).not.toContain('disabled');
  options={...options,settingsOpen:false};await act(async()=>{render(h(Host,{}),container);});await flushMicrotasks();expect(node.leftRooms).toContain('c');
  const changed=structuredClone(config);changed.providers=changed.providers.filter(p=>p.id!==a.id);options={...options,config:changed};await act(async()=>{render(h(Host,{}),container);});await flushMicrotasks();expect(node.leftRooms).toContain('a');
  await act(async()=>{render(null,container);});await flushMicrotasks();expect(node.leftRooms).toContain('b');expect(consumers.roomConsumer('b').status.phase).toBe('idle');
});

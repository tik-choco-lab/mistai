import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createSharedNodeScope } from '../shared-node.js';
import { createRoomConsumers } from '../rooms.js';
import { RoomProviderService, inboundTarget, resolveSharedTargets, roomOaiUpstream } from '../room-provider.js';
import { emptyLlmConfig, createProvider, patchProvider, createRoomProvider } from '../llm-config.js';
import { EVENT_RAW } from '../node.js';
import { encode } from '../protocol.js';
import { FakeMistNode, flushMicrotasks } from './fake-node.js';
beforeEach(()=>{const map=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>map.set(k,v)});});
afterEach(()=>vi.unstubAllGlobals());
function setup(){const config=emptyLlmConfig(),a=createProvider(config,'A'),b=createProvider(config,'B'),room=createRoomProvider(config,{roomId:'team'});patchProvider(config,a,{baseUrl:'https://a.test/v1',models:['raw']});patchProvider(config,b,{baseUrl:'https://b.test/v1',models:['raw']});config.defaultModel={providerId:a,model:'default'};return {config,a,b,room,shared:[{providerId:b,model:'raw'},{providerId:a,model:'raw'}]};}
it('keeps multiple consumers over one node, filters room events and scopes outbound messages',async()=>{
  const node=new FakeMistNode('peer');const init=vi.spyOn(node,'init');const rooms=createRoomConsumers(createSharedNodeScope(()=>node));const a=rooms.roomConsumer(' a '),b=rooms.roomConsumer('b');expect(rooms.roomConsumer('a')).toBe(a);expect(a).not.toBe(b);await Promise.all([a.connect('a'),b.connect('b')]);expect(init).toHaveBeenCalledTimes(1);expect(node.joinedRooms).toEqual(['a','b']);expect(node.sent.map(s=>s.roomId)).toEqual(['a','b']);
  node.emit(EVENT_RAW,'remote',encode({v:1,type:'provider_hello',models:['only-a'],services:['chat']}),'a');expect(a.status).toMatchObject({phase:'connected',models:['only-a']});expect(b.status.phase).toBe('searching');rooms.disconnectRoom(' a ');expect(a.status.phase).toBe('idle');expect(b.status.phase).toBe('searching');expect(node.leftRooms).toEqual(['a']);rooms.disconnectRoom('b');
});
it('waits for async room readiness, buffers early hellos and releases a canceled join after readiness',async()=>{
  const node=new FakeMistNode('peer');let ready!:()=>void;
  const asyncNode=Object.assign(node,{joinRoomAsync:vi.fn(()=>new Promise<void>(resolve=>{ready=resolve;}))});
  const scope=createSharedNodeScope(()=>asyncNode),a=scope('peer'),b=scope('peer');await Promise.all([a.init(),b.init()]);const joining=a.joinRoom('room');b.joinRoom('room');a.sendMessage(null,encode({v:1,type:'consumer_hello'}));expect(node.sent).toHaveLength(0);expect(asyncNode.joinRoomAsync).toHaveBeenCalledTimes(1);a.leaveRoom();b.leaveRoom();expect(node.leftRooms).toEqual([]);ready();await joining;await flushMicrotasks();expect(node.leftRooms).toEqual(['room']);expect(node.sent).toHaveLength(0);
});
it('first usable shared raw ID wins; labels do not route and room refs cannot loop',()=>{
  const {config,a,b,shared,room}=setup();expect(inboundTarget(config,shared,'raw')?.providerId).toBe(b);expect(()=>inboundTarget(config,shared,'B')).toThrow('model_not_shared');expect(inboundTarget(config,shared,'')?.model).toBe('default');config.defaultModel={providerId:room.id,model:'remote'};expect(inboundTarget(config,shared)?.providerId).toBe(b);patchProvider(config,b,{enabled:false});expect(inboundTarget(config,shared,'raw')?.providerId).toBe(a);expect(resolveSharedTargets(config,[{providerId:room.id,model:'remote'}])).toEqual([]);patchProvider(config,a,{enabled:false});expect(()=>inboundTarget(config,shared,'raw')).toThrow('model_not_shared');expect(inboundTarget(config,shared)).toBeNull();
});
it('empty share list allows only HTTP default fallback and does not pick an arbitrary model',()=>{
  const {config,room}=setup();expect(inboundTarget(config,[],'requested')?.model).toBe('default');config.defaultModel={providerId:room.id,model:'remote'};expect(inboundTarget(config,[])).toBeNull();
});
it('oai tunnel enforces the same allowlist, model rules and removes temperature',()=>{
  const {config,shared}=setup(),resolve=roomOaiUpstream(config,shared);expect(resolve('/audio/speech',{})).toBeNull();expect(()=>resolve('/chat/completions',{model:'unknown'})).toThrow('model_not_shared');const upstream=resolve('/chat/completions',{model:'raw'})!;expect(upstream.baseUrl).toBe('https://b.test/v1');expect(upstream.rewriteBody?.({model:'raw',temperature:.8,stream:true,reasoning_effort:'none'})).toEqual({model:'raw',stream:false,reasoning_effort:'none'});
});
it('provides independently in two rooms, rebroadcasts raw ids without rejoining, and emits model_not_shared on wire',async()=>{
  const {config,a,b,room,shared}=setup(),room2=createRoomProvider(config,{roomId:'other'}),node=new FakeMistNode('peer'),consumers=createRoomConsumers(createSharedNodeScope(()=>node));
  const roomProvide={ [room.id]:{enabled:true,shared},[room2.id]:{enabled:true,shared:[{providerId:a,model:'second'}]} };
  const manager=new RoomProviderService({config,roomProvide,consumers});await flushMicrotasks();expect(Object.values(manager.states).map(s=>s.status)).toEqual(['connected','connected']);expect(node.joinedRooms).toEqual(['team','other']);const hellos=node.sentMessages().filter(s=>s.msg?.type==='provider_hello').map(s=>s.msg);expect(hellos).toMatchObject([{models:['raw'],services:['chat','oai']},{models:['second'],services:['chat','oai']}]);
  node.emit(EVENT_RAW,'remote',encode({v:1,type:'llm_request',id:'bad',model:'unknown',messages:[{role:'user',content:'hi'}]}),'team');await flushMicrotasks();expect(node.sentMessages().find(s=>s.msg?.type==='llm_error')?.msg).toMatchObject({code:'model_not_shared'});
  const next={...roomProvide,[room.id]:{enabled:true,shared:[{providerId:b,model:'changed'}]}};manager.update({config,roomProvide:next,consumers});expect(node.joinedRooms).toEqual(['team','other']);expect(node.sentMessages().at(-1)?.msg).toMatchObject({type:'provider_hello',models:['changed']});patchProvider(config,room.id,{enabled:false});manager.update({config,roomProvide:next,consumers});expect(node.leftRooms).toEqual(['team']);expect(Object.keys(manager.states)).toEqual([room2.id]);manager.destroy();expect(node.leftRooms).toEqual(['team','other']);
});

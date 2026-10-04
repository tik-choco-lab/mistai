import { resolveModelExact, resolveVoice, providerKind, roomIdFromBaseUrl, type ModelRefV1, type ResolvedLlmTargetV1, type SharedLlmConfigV1 } from './llm-config.js';
import { Network } from './node.js';
import { streamChatCompletion, fetchVoices } from './openai.js';
import { ProviderService, rejectLlmRequest, type ProviderLogEntry } from './provider.js';
import { VoiceProviderService, rejectVoiceRequest } from './voice-provider.js';
import { OaiTunnelProvider, type OaiUpstreamResolver } from './tunnel.js';
import { getRoomConsumers, type RoomConsumers } from './rooms.js';
import type { ProviderHelloMsg } from './protocol.js';

export type RoomProvideV1 = { enabled: boolean; shared: ModelRefV1[] };
export type RoomProviderState = {
  status: 'idle' | 'connecting' | 'connected' | 'error'; statusUpdatedAt: number;
  errorMessage: string | null; ownNodeId: string | null;
  peers: { nodeId: string; connectedAt: number; isConsumer: boolean }[];
  logs: ProviderLogEntry[]; consumerCount: number; upstreamConfigured: boolean;
};
export function resolveSharedTargets(config: SharedLlmConfigV1, refs: ModelRefV1[]): ResolvedLlmTargetV1[] {
  return refs.map(ref => resolveModelExact(config, ref)).filter((target): target is ResolvedLlmTargetV1 => !!target && providerKind(target) === 'http');
}
/** SPEC #8, including rejection when the stored list has no currently usable refs. */
export function inboundTarget(config: SharedLlmConfigV1, shared: ModelRefV1[], model?: string): ResolvedLlmTargetV1 | null {
  const targets = resolveSharedTargets(config, shared);
  if (model) {
    const match = targets.find(target => target.model === model);
    if (match) return match;
    if (shared.length) throw new Error('model_not_shared');
  }
  const target = resolveModelExact(config, config.defaultModel);
  return target && providerKind(target) === 'http' ? target : targets[0] ?? null;
}
export function roomOaiUpstream(config: SharedLlmConfigV1, shared: ModelRefV1[]): OaiUpstreamResolver {
  return (path, body) => {
    if (!['/chat/completions', '/models', '/embeddings'].includes(path)) return null;
    const requested = typeof (body as { model?: unknown })?.model === 'string' ? (body as { model: string }).model : '';
    const target = inboundTarget(config, shared, requested);
    if (!target) return null;
    return { baseUrl: target.baseUrl, apiKey: target.apiKey, rewriteBody: value => {
      const { temperature: _temperature, ...rest } = (value ?? {}) as Record<string, unknown>;
      return { ...rest, model: target.model, ...(path === '/chat/completions' ? { stream: false } : {}) };
    } };
  };
}

export interface RoomProviderOptions {
  config: SharedLlmConfigV1;
  roomProvide: Record<string, RoomProvideV1>;
  consumers?: RoomConsumers;
  reasoningEffort?: string;
  maxLogEntries?: number;
}
type Session = { roomId: string; network: Network; voice: VoiceProviderService; tunnel: OaiTunnelProvider; state: RoomProviderState; helloKey: string; voices: string[]; voiceKey: string };

/** Per-room services sharing the host's node, with live rebroadcast on edits. */
export class RoomProviderService {
  private options: RoomProviderOptions;
  private readonly consumers: RoomConsumers;
  private readonly sessions = new Map<string, Session>();
  private readonly listeners = new Set<() => void>();
  constructor(options: RoomProviderOptions) { this.options = options; this.consumers = options.consumers ?? getRoomConsumers(); this.update(options); }
  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private notify() { this.listeners.forEach(cb => cb()); }
  get states(): Record<string, RoomProviderState> { return Object.fromEntries([...this.sessions].map(([id, s]) => [id, { ...s.state, peers: [...s.state.peers], logs: [...s.state.logs] }])); }
  private shared(id: string) { return this.options.roomProvide[id]?.shared ?? []; }
  private voiceTarget(kind: 'tts' | 'stt') { const target = resolveVoice(this.options.config, kind); return target && providerKind(target) === 'http' ? target : null; }
  private hello(id: string, s: Session): ProviderHelloMsg {
    const models = [...new Set(resolveSharedTargets(this.options.config, this.shared(id)).map(target => target.model))].sort();
    s.state.upstreamConfigured = !!inboundTarget(this.options.config, this.shared(id));
    return { v: 1, type: 'provider_hello', models, voices: s.voices, services: [ ...(s.state.upstreamConfigured ? ['chat', 'oai'] : []), ...(this.voiceTarget('tts') ? ['tts'] : []), ...(this.voiceTarget('stt') ? ['stt'] : []) ] };
  }
  update(options: RoomProviderOptions): void {
    this.options = options;
    const wanted = options.config.providers.filter(p => p.enabled !== false && providerKind(p) === 'room' && options.roomProvide[p.id]?.enabled && roomIdFromBaseUrl(p.baseUrl));
    for (const [id, s] of this.sessions) if (!wanted.some(p => p.id === id && roomIdFromBaseUrl(p.baseUrl) === s.roomId)) { s.network.destroy(); this.sessions.delete(id); }
    for (const provider of wanted) {
      let session = this.sessions.get(provider.id);
      if (!session) { session = this.start(provider.id, roomIdFromBaseUrl(provider.baseUrl)); this.sessions.set(provider.id, session); }
      const hello = this.hello(provider.id, session), key = JSON.stringify(hello);
      if (key !== session.helloKey) { session.helloKey = key; if (session.state.status === 'connected') session.network.send(null, hello); }
      const target = this.voiceTarget('tts');
      const voiceKey = target ? JSON.stringify([target.baseUrl, target.apiKey]) : '';
      if (voiceKey !== session.voiceKey) {
        session.voiceKey = voiceKey; session.voices = [];
        if (target) { const current = session; void fetchVoices(target.baseUrl, target.apiKey).then(voices => {
          if (this.sessions.get(provider.id) !== current || current.voiceKey !== voiceKey) return;
          current.voices = voices.slice(0, 64); current.network.send(null, this.hello(provider.id, current)); this.notify();
        }); }
      }
    }
    this.notify();
  }
  private start(id: string, roomId: string): Session {
    const log = (entry: ProviderLogEntry) => { s.state.logs = [entry, ...s.state.logs.filter(e => e.id !== entry.id)].slice(0, this.options.maxLogEntries ?? 50); this.notify(); };
    const network = new Network({ createNode: this.consumers.nodeScope, nodeIdStorageKey: this.consumers.nodeIdStorageKey, callbacks: {
      onPeerConnected: nodeId => { if (!s.state.peers.some(p => p.nodeId === nodeId)) s.state.peers.push({ nodeId, connectedAt: Date.now(), isConsumer: false }); network.send(nodeId, this.hello(id, s)); this.notify(); },
      onPeerDisconnected: nodeId => { s.state.peers = s.state.peers.filter(p => p.nodeId !== nodeId); s.state.consumerCount = s.state.peers.filter(p => p.isConsumer).length; s.voice.dropPeer(nodeId); s.tunnel.dropPeer(nodeId); this.notify(); },
      onMessage: (from, msg) => {
        if (s.tunnel.handleMessage(from, msg)) return;
        if (msg.type === 'consumer_hello') {
          const peer = s.state.peers.find(p => p.nodeId === from);
          if (peer) peer.isConsumer = true; else s.state.peers.push({ nodeId: from, connectedAt: Date.now(), isConsumer: true });
          s.state.consumerCount = s.state.peers.filter(p => p.isConsumer).length; network.send(from, this.hello(id, s)); this.notify();
        } else if (msg.type === 'llm_request') { if (this.hello(id, s).services?.includes('chat')) void chat.handleMessage(from, msg); else rejectLlmRequest(send, from, msg.id); }
        else if (msg.type === 'tts_request' || msg.type === 'stt_request') {
          const kind = msg.type === 'tts_request' ? 'tts' : 'stt';
          if (this.voiceTarget(kind)) void s.voice.handleMessage(from, msg);
          else if (msg.type === 'tts_request' || msg.seq === 0) rejectVoiceRequest(send, from, msg.id, kind);
        }
      },
    } });
    const send = (to: string, msg: Parameters<Network['send']>[1]) => network.send(to, msg);
    const chat = new ProviderService(send, (messages, model, onDelta) => {
      const target = inboundTarget(this.options.config, this.shared(id), model);
      if (!target) throw new Error('No usable HTTP model configured.');
      return streamChatCompletion({ ...target, reasoningEffort: this.options.reasoningEffort }, messages, onDelta);
    }, { onRequestLog: log });
    const voice = new VoiceProviderService(send, async (text, _model, voice) => {
      const target = this.voiceTarget('tts'); if (!target) throw new Error('No HTTP TTS model configured.');
      const response = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/audio/speech`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` }, body: JSON.stringify({ model: target.model, input: text, ...(voice || target.voice ? { voice: voice || target.voice } : {}), ...(target.speed !== undefined ? { speed: target.speed } : {}), response_format: 'mp3' }) });
      if (!response.ok) throw new Error(`Speech request failed with ${response.status}`);
      const blob = await response.blob(); return { blob, mime: blob.type || 'audio/mpeg' };
    }, async (audio, _mime, _model, fileName) => {
      const target = this.voiceTarget('stt'); if (!target) throw new Error('No HTTP STT model configured.');
      const form = new FormData(); form.append('file', audio, (fileName ?? 'recording.webm').replace(/[\r\n"\\/]+/g, '_').slice(0, 255)); form.append('model', target.model);
      const response = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${target.apiKey}` }, body: form });
      const payload = await response.json(); if (!response.ok || typeof payload?.text !== 'string' || !payload.text.trim()) throw new Error(`Transcription failed with ${response.status}`); return payload.text as string;
    }, { onRequestLog: log });
    const tunnel = new OaiTunnelProvider(send, (path, body) => roomOaiUpstream(this.options.config, this.shared(id))(path, body));
    const s: Session = { roomId, network, voice, tunnel, helloKey: '', voices: [], voiceKey: '', state: { status: 'connecting', statusUpdatedAt: Date.now(), errorMessage: null, peers: [], logs: [], ownNodeId: network.id, consumerCount: 0, upstreamConfigured: false } };
    void network.join(roomId).then(() => {
      if (this.sessions.get(id) !== s) return;
      s.state.status = 'connected'; s.state.statusUpdatedAt = Date.now(); network.send(null, this.hello(id, s)); this.notify();
    }).catch(error => { if (this.sessions.get(id) !== s) return; network.destroy(); s.state.status = 'error'; s.state.errorMessage = error instanceof Error ? error.message : String(error); s.state.statusUpdatedAt = Date.now(); this.notify(); });
    return s;
  }
  destroy(): void { for (const s of this.sessions.values()) s.network.destroy(); this.sessions.clear(); this.notify(); this.listeners.clear(); }
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsumerService } from '../consumer.js';
import { ConsumerClient } from '../client.js';
import { ProviderService } from '../provider.js';
import { createRoomConsumers, requestRoomChat } from '../rooms.js';
import { decode, encode, type ChatMessage, type LlmRequestMsg, type ProtocolMessage } from '../protocol.js';
import { EVENT_RAW } from '../node.js';
import { FakeMistNode, flushMicrotasks } from './fake-node.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
const request: LlmRequestMsg = { v: 1, type: 'llm_request', id: 'request', messages };
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'future-effort', ''];
afterEach(() => vi.unstubAllGlobals());

describe('reasoning effort on wire v1', () => {
  it.each(efforts)('round-trips effort %j unchanged', reasoning_effort => {
    const msg = { ...request, reasoning_effort };
    expect(decode(encode(msg))).toEqual(msg);
  });

  it.each([null, 3, false, {}, []])('drops invalid optional effort %j without losing an old request', reasoning_effort => {
    expect(decode(JSON.stringify({ ...request, reasoning_effort }))).toEqual(request);
  });

  it('round-trips an old-consumer request with no field', () => {
    expect(decode(encode(request))).toEqual(request);
    expect(decode(encode(request))).not.toHaveProperty('reasoning_effort');
  });

  it.each([...efforts, undefined])('consumer sends effort %j and provider applies its default only when absent', async reasoningEffort => {
    const onDelta = vi.fn();
    const callLlm = vi.fn(async (_messages, _model, delta: (value: string) => void, _effort?: string) => {
      delta('answer');
      return 'answer';
    });
    const replies: ProtocolMessage[] = [];
    const provider = new ProviderService((_to, msg) => {
      replies.push(msg);
      consumer.handleMessage(decode(encode(msg))!);
    }, callLlm, { reasoningEffort: 'medium' });
    const sent: LlmRequestMsg[] = [];
    const consumer = new ConsumerService((to, msg) => {
      const decoded = decode(encode(msg)) as LlmRequestMsg;
      sent.push(decoded);
      void provider.handleMessage(to, decoded);
    });
    await expect(consumer.request('provider', messages, { reasoningEffort, onDelta })).resolves.toBe('answer');
    if (reasoningEffort === undefined) expect(sent[0]).not.toHaveProperty('reasoning_effort');
    else expect(sent[0].reasoning_effort).toBe(reasoningEffort);
    expect(callLlm).toHaveBeenCalledWith(messages, undefined, expect.any(Function), reasoningEffort ?? 'medium');
    expect(onDelta).toHaveBeenCalledWith('answer', 'answer');
    expect(replies.map(msg => msg.type)).toEqual(['llm_response_chunk', 'llm_response_done']);
  });

  it('new consumer works with an old provider that strips the field and sends legacy chunks', async () => {
    const onDelta = vi.fn();
    let legacyRequest: LlmRequestMsg | undefined;
    const consumer = new ConsumerService((_to, msg) => {
      // The pre-0.9.1 decoder retains only these known llm_request fields.
      const wire = JSON.parse(new TextDecoder().decode(encode(msg))) as LlmRequestMsg;
      legacyRequest = { v: 1, type: 'llm_request', id: wire.id, messages: wire.messages,
        ...(wire.model !== undefined ? { model: wire.model } : {}) };
      consumer.handleMessage(decode(encode({ v: 1, type: 'llm_response_chunk', id: wire.id, delta: 'legacy' }))!);
      consumer.handleMessage(decode(encode({ v: 1, type: 'llm_response_done', id: wire.id }))!);
    });
    await expect(consumer.request('old-provider', messages, { model: 'raw', reasoningEffort: 'high', onDelta })).resolves.toBe('legacy');
    expect(legacyRequest).toMatchObject({ messages, model: 'raw' });
    expect(legacyRequest).not.toHaveProperty('reasoning_effort');
    expect(onDelta).toHaveBeenCalledWith('legacy', 'legacy');
  });

  it('keeps a three-argument provider callback compatible with new requests', async () => {
    const send = vi.fn();
    const provider = new ProviderService(send, async (_messages, _model, onDelta) => {
      onDelta('old handler');
      return 'old handler';
    });
    await provider.handleMessage('consumer', { ...request, reasoning_effort: 'none' });
    expect(send).toHaveBeenLastCalledWith('consumer', { v: 1, type: 'llm_response_done', id: request.id, content: 'old handler' });
  });
});

describe('chat entry points', () => {
  it('preserves task effort when failing over before streaming starts', async () => {
    const node = new FakeMistNode('consumer');
    const client = new ConsumerClient({ createNode: () => node });
    try {
      await client.connect('team');
      for (const id of ['first', 'second']) node.emit(EVENT_RAW, id, encode({ v: 1, type: 'provider_hello', models: ['raw'] }));
      const reply = client.requestChat('team', messages, { model: 'raw', reasoningEffort: 'max' });
      await flushMicrotasks();
      const first = node.sentMessages().find(sent => sent.msg?.type === 'llm_request')!;
      node.emit(EVENT_RAW, first.toId!, encode({ v: 1, type: 'llm_error', id: (first.msg as LlmRequestMsg).id, message: 'unsupported', code: 'unsupported_service' }));
      await flushMicrotasks();
      const retry = node.sentMessages().filter(sent => sent.msg?.type === 'llm_request').at(-1)!;
      expect(retry.toId).not.toBe(first.toId);
      expect(first.msg).toMatchObject({ model: 'raw', reasoning_effort: 'max' });
      expect(retry.msg).toMatchObject({ model: 'raw', reasoning_effort: 'max' });
      node.emit(EVENT_RAW, retry.toId!, encode({ v: 1, type: 'llm_response_done', id: (retry.msg as LlmRequestMsg).id, content: 'ok' }));
      await expect(reply).resolves.toBe('ok');
    } finally { client.disconnect(); }
  });

  it('requestChat preserves effort when falling back to a provider with no model catalog', async () => {
    const node = new FakeMistNode('consumer');
    const client = new ConsumerClient({ createNode: () => node });
    try {
      await client.connect('team');
      node.emit(EVENT_RAW, 'provider', encode({ v: 1, type: 'provider_hello' }));
      const reply = client.requestChat('team', messages, { model: 'raw', reasoningEffort: 'none' });
      await flushMicrotasks();
      const msg = node.sentMessages().find(sent => sent.msg?.type === 'llm_request')!.msg as LlmRequestMsg;
      expect(msg).not.toHaveProperty('model');
      expect(msg.reasoning_effort).toBe('none');
      node.emit(EVENT_RAW, 'provider', encode({ v: 1, type: 'llm_response_done', id: msg.id, content: 'ok' }));
      await expect(reply).resolves.toBe('ok');
    } finally { client.disconnect(); }
  });

  it('requestRoomChat supports the streaming options helper and legacy positional calls', async () => {
    const node = new FakeMistNode('consumer');
    const rooms = createRoomConsumers(() => node);
    try {
      await rooms.roomConsumer('team').connect('team');
      node.emit(EVENT_RAW, 'provider', encode({ v: 1, type: 'provider_hello', models: ['raw'] }));
      for (const legacy of [false, true]) {
        const onDelta = vi.fn();
        const reply = legacy
          ? rooms.requestRoomChat(' team ', messages, 'raw', onDelta)
          : requestRoomChat(' team ', messages, { model: 'raw', reasoningEffort: 'high', onDelta });
        await flushMicrotasks();
        const msg = node.sentMessages().filter(sent => sent.msg?.type === 'llm_request').at(-1)!.msg as LlmRequestMsg;
        expect(msg.model).toBe('raw');
        if (legacy) expect(msg).not.toHaveProperty('reasoning_effort');
        else expect(msg.reasoning_effort).toBe('high');
        expect(node.sentMessages().some(sent => sent.msg?.type === 'oai_request')).toBe(false);
        node.emit(EVENT_RAW, 'provider', encode({ v: 1, type: 'llm_response_chunk', id: msg.id, delta: 'ok', seq: 0 }));
        node.emit(EVENT_RAW, 'provider', encode({ v: 1, type: 'llm_response_done', id: msg.id }));
        await expect(reply).resolves.toBe('ok');
        expect(onDelta).toHaveBeenCalledWith('ok', 'ok');
      }
    } finally { rooms.disconnectRoom('team'); }
  });
});

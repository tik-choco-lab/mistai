import { describe, expect, it, vi } from 'vitest';
import { decode, encode, isTtsSpeed, type TtsRequestMsg } from '../protocol.js';
import { VoiceConsumerService } from '../voice-consumer.js';
import { VoiceProviderService, type SynthesizeFn } from '../voice-provider.js';

const request: TtsRequestMsg = { v: 1, type: 'tts_request', id: 'tts', text: 'hello' };
const invalidSpeeds = [0.24, 4.01, -1, 0, NaN, Infinity, -Infinity, '1', null, {}, []];

describe('TTS optional hints', () => {
  it.each([0.25, 1, 1.25, 4])('round-trips speed %s', speed => {
    expect(decode(encode({ ...request, speed }))).toEqual({ ...request, speed });
  });
  it.each(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])('round-trips format %s', response_format => {
    expect(decode(encode({ ...request, response_format }))).toEqual({ ...request, response_format });
  });
  it.each(invalidSpeeds)('ignores invalid speed %s without dropping valid format', speed => {
    expect(isTtsSpeed(speed)).toBe(false);
    expect(decode(JSON.stringify({ ...request, speed, response_format: 'wav' })))
      .toEqual({ ...request, response_format: 'wav' });
  });
  it.each(['unknown', 'MP3', '', 1, null, {}, []])('ignores invalid format %s without dropping valid speed', response_format => {
    expect(decode(JSON.stringify({ ...request, speed: 1.5, response_format })))
      .toEqual({ ...request, speed: 1.5 });
  });
  it('passes both hints in one trailing object and trusts the actual response MIME', async () => {
    // A four-argument implementation remains assignable to the new function type.
    const legacy: SynthesizeFn = async (_text, _model, _voice, _lang) => ({ blob: new Blob(['audio']), mime: 'audio/wav' });
    const synthesize = vi.fn(legacy);
    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService((_to, msg) => consumer.handleMessage(msg), synthesize, async () => '');
    const send = vi.fn((_to: string, msg: Parameters<typeof encode>[0]) => {
      void provider.handleMessage('consumer', decode(encode(msg))!);
    });
    consumer = new VoiceConsumerService(send);
    const blob = await consumer.requestTts('provider', { text: 'hello', model: 'speech', voice: 'alloy', lang: 'ja', speed: 1.5, responseFormat: 'opus' });
    expect(send.mock.calls[0][1]).toMatchObject({ speed: 1.5, response_format: 'opus' });
    expect(send.mock.calls[0][1]).not.toHaveProperty('responseFormat');
    expect(synthesize).toHaveBeenCalledWith('hello', 'speech', 'alloy', 'ja', { speed: 1.5, responseFormat: 'opus' });
    expect(blob.type).toBe('audio/wav');
  });
  it.each(invalidSpeeds)('consumer and direct provider ignore invalid speed %s independently', async speed => {
    const synthesize = vi.fn(async () => ({ blob: new Blob([]), mime: 'audio/mpeg' }));
    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService((_to, msg) => consumer.handleMessage(msg), synthesize, async () => '');
    const send = vi.fn((_to: string, msg: Parameters<typeof encode>[0]) => { void provider.handleMessage('consumer', msg); });
    consumer = new VoiceConsumerService(send);
    await consumer.requestTts('provider', { text: 'hello', speed: speed as number, responseFormat: 'wav' });
    expect(send.mock.calls[0][1]).not.toHaveProperty('speed');
    expect(synthesize).toHaveBeenLastCalledWith('hello', undefined, undefined, undefined, { responseFormat: 'wav' });
    await provider.handleMessage('consumer', { ...request, speed: speed as number, response_format: 'invalid' });
    expect(synthesize).toHaveBeenLastCalledWith('hello', undefined, undefined, undefined, {});
  });
  it('omits hints when absent or when only the format is invalid', async () => {
    const synthesize = vi.fn(async () => ({ blob: new Blob([]), mime: 'audio/mpeg' }));
    let consumer: VoiceConsumerService;
    const provider = new VoiceProviderService((_to, msg) => consumer.handleMessage(msg), synthesize, async () => '');
    const send = vi.fn((_to: string, msg: Parameters<typeof encode>[0]) => { void provider.handleMessage('consumer', msg); });
    consumer = new VoiceConsumerService(send);
    await consumer.requestTts('provider', { text: 'hello' });
    expect(send.mock.calls[0][1]).not.toHaveProperty('speed');
    expect(send.mock.calls[0][1]).not.toHaveProperty('response_format');
    await consumer.requestTts('provider', { text: 'hello', speed: 2, responseFormat: 'invalid' });
    expect(send.mock.calls[1][1]).toMatchObject({ speed: 2 });
    expect(send.mock.calls[1][1]).not.toHaveProperty('response_format');
    expect(synthesize).toHaveBeenLastCalledWith('hello', undefined, undefined, undefined, { speed: 2 });
  });
});

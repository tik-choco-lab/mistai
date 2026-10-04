// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useRoomProviders } from '../preact/room-providers.js';
import { emptyLlmConfig, createProvider, createRoomProvider } from '../llm-config.js';
import { createRoomConsumers } from '../rooms.js';
import { createSharedNodeScope } from '../shared-node.js';
import { FakeMistNode, flushMicrotasks } from './fake-node.js';

it('preserves an on-demand room consumer through model-cache updates and hook unmount', async () => {
  const config = emptyLlmConfig();
  const local = createProvider(config, 'HTTP');
  const room = createRoomProvider(config, { roomId: 'on-demand' });
  config.defaultModel = { providerId: local, model: 'local-model' };
  const node = new FakeMistNode('peer');
  const consumers = createRoomConsumers(createSharedNodeScope(() => node));
  let options = { config, consumers, roomProvide: {}, settingsOpen: false };
  const Host = () => { useRoomProviders(options); return null; };
  const container = document.createElement('div');
  document.body.append(container);
  try {
    await act(async () => render(h(Host, {}), container));
    await consumers.roomConsumer('on-demand').connect('on-demand');
    await flushMicrotasks();
    expect(node.joinedRooms).toContain('on-demand');
    // provider_hello caches discovered models in config, rerunning the hook.
    options = { ...options, config: { ...config, providers: config.providers.map(p =>
      p.id === room.id ? { ...p, models: ['remote-model'] } : p) } };
    await act(async () => render(h(Host, {}), container));
    await flushMicrotasks();
    expect(node.leftRooms).not.toContain('on-demand');
    expect(consumers.roomConsumer('on-demand').status.phase).not.toBe('idle');
    await act(async () => render(null, container));
    expect(node.leftRooms).not.toContain('on-demand');
  } finally {
    act(() => render(null, container));
    consumers.disconnectRoom('on-demand');
    container.remove();
  }
});

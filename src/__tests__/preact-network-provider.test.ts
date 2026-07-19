// Exercises useNetworkProvider (../preact/index.ts) end to end, including the
// fork-derived additions: extraServices / resolveOaiUpstream->'oai' merging
// into provider_hello.services, and the hello re-broadcast effect (send a
// fresh provider_hello to all peers, without leaving the room, whenever what
// it would advertise changes on an already-connected session).
//
// There's no @testing-library/preact (or jsdom/happy-dom) dependency in this
// package, so this uses a minimal hand-rolled renderHook: preact's own
// render() only touches the DOM when a component actually produces DOM
// output, and every "component" here always renders `null` — so a plain
// object stands in for the DOM container. preact/hooks schedules useEffect
// callbacks via requestAnimationFrame, falling back (no rAF in Node) to a
// ~35ms setTimeout chain (see node_modules/preact/hooks/src/index.js), hence
// the real-timer flushEffects() helper below instead of a microtask flush.

import { afterEach, describe, expect, it } from "vitest";
import { h, render, type VNode } from "preact";
import {
  useNetworkProvider,
  type UseNetworkProviderOptions,
  type UseNetworkProviderResult,
} from "../preact/index.js";
import type { OaiUpstream } from "../tunnel.js";
import { FakeMistNode } from "./fake-node.js";

// preact.render()'s only use of `document` is an identity check
// (`parentDom == document`); an empty stub satisfies it without pulling in a
// real DOM, since these tests never render actual elements.
(globalThis as { document?: unknown }).document ??= {};

async function flushEffects(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 60));
}

function renderProviderHook(getOptions: () => UseNetworkProviderOptions) {
  const result: { current: UseNetworkProviderResult | undefined } = { current: undefined };
  const container = {} as unknown as Element;
  function Test(): VNode | null {
    result.current = useNetworkProvider(getOptions());
    return null;
  }
  render(h(Test, {}), container);
  return {
    result,
    rerender: () => render(h(Test, {}), container),
    unmount: () => render(null, container),
  };
}

function helloMessages(node: FakeMistNode) {
  return node.sentMessages().filter((m) => m.msg?.type === "provider_hello");
}

describe("useNetworkProvider hello re-broadcast", () => {
  afterEach(() => {
    // Each test unmounts explicitly; nothing global to reset.
  });

  it("re-sends provider_hello to all peers when advertisedModels changes on a connected session", async () => {
    const nodes: FakeMistNode[] = [];
    let advertisedModels = ["m1"];
    const getOptions = (): UseNetworkProviderOptions => ({
      enabled: true,
      roomId: "room1",
      createNode: (nodeId) => {
        const node = new FakeMistNode(nodeId);
        nodes.push(node);
        return node;
      },
      callLlm: async () => "unused",
      advertisedModels,
    });

    const { result, rerender, unmount } = renderProviderHook(getOptions);
    await flushEffects();
    expect(result.current?.status).toBe("connected");

    const node = nodes[0];
    expect(helloMessages(node)).toHaveLength(1);
    expect(helloMessages(node)[0].toId).toBeNull();

    // An unrelated re-render (nothing advertised changed) must NOT re-send hello.
    rerender();
    await flushEffects();
    expect(helloMessages(node)).toHaveLength(1);

    // Changing advertisedModels while connected re-broadcasts hello to null (all peers).
    advertisedModels = ["m1", "m2"];
    rerender();
    await flushEffects();
    const hellos = helloMessages(node);
    expect(hellos).toHaveLength(2);
    expect(hellos[1].toId).toBeNull();
    expect((hellos[1].msg as { models?: string[] }).models).toEqual(["m1", "m2"]);

    // Only one real node was ever created — the room/network was never torn down and rejoined.
    expect(nodes).toHaveLength(1);
    expect(node.joinedRooms).toEqual(["room1"]);

    unmount();
  });

  it("does not re-broadcast while still connecting, and does not touch node identity across renders", async () => {
    const nodes: FakeMistNode[] = [];
    let extraServices: string[] = [];
    const getOptions = (): UseNetworkProviderOptions => ({
      enabled: true,
      roomId: "room1",
      createNode: (nodeId) => {
        const node = new FakeMistNode(nodeId);
        nodes.push(node);
        return node;
      },
      callLlm: async () => "unused",
      extraServices,
    });

    const { result, rerender, unmount } = renderProviderHook(getOptions);
    // Re-render synchronously, before the join promise has resolved: still "connecting".
    extraServices = ["custom"];
    rerender();
    expect(result.current?.status).not.toBe("connected");

    await flushEffects();
    expect(result.current?.status).toBe("connected");
    // The join's own broadcast already advertises the latest options (read from the ref),
    // so no separate re-broadcast is needed for a change that landed before connection completed.
    expect(helloMessages(nodes[0])).toHaveLength(1);
    expect((helloMessages(nodes[0])[0].msg as { services: string[] }).services).toContain("custom");

    unmount();
  });

  it("merges extraServices and auto-adds 'oai' when resolveOaiUpstream is provided, and routes oai_request to it", async () => {
    const nodes: FakeMistNode[] = [];
    const upstream: OaiUpstream = { baseUrl: "https://api.example.com", apiKey: "k" };
    const getOptions = (): UseNetworkProviderOptions => ({
      enabled: true,
      roomId: "room1",
      createNode: (nodeId) => {
        const node = new FakeMistNode(nodeId);
        nodes.push(node);
        return node;
      },
      extraServices: ["custom"],
      resolveOaiUpstream: (path) => (path === "/chat/completions" ? upstream : null),
    });

    const { unmount } = renderProviderHook(getOptions);
    await flushEffects();

    const node = nodes[0];
    const hello = helloMessages(node)[0].msg as { services: string[] };
    expect(hello.services).toEqual(expect.arrayContaining(["custom", "oai"]));

    unmount();
  });
});

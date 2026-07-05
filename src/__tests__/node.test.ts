import { describe, expect, it, vi } from "vitest";
import {
  DELIVERY_RELIABLE,
  EVENT_PEER_CONNECTED,
  EVENT_PEER_DISCONNECTED,
  EVENT_RAW,
  Network,
} from "../node.js";
import { encode, type ProtocolMessage } from "../protocol.js";
import { FakeMistNode, SlowInitFakeMistNode } from "./fake-node.js";

describe("Network", () => {
  it("exposes the injected nodeId and current room", async () => {
    const node = new FakeMistNode("n1");
    const network = new Network({ createNode: () => node, nodeId: "n1" });
    expect(network.id).toBe("n1");
    expect(network.currentRoomId).toBeNull();
    await network.join("room1");
    expect(network.currentRoomId).toBe("room1");
    expect(node.joinedRooms).toEqual(["room1"]);
    network.destroy();
    expect(network.currentRoomId).toBeNull();
  });

  it("wires events to callbacks after join", async () => {
    const node = new FakeMistNode("n1");
    const onMessage = vi.fn();
    const onPeerConnected = vi.fn();
    const onPeerDisconnected = vi.fn();
    const network = new Network({
      createNode: () => node,
      nodeId: "n1",
      callbacks: { onMessage, onPeerConnected, onPeerDisconnected },
    });
    await network.join("room1");

    node.emit(EVENT_RAW, "peer1", encode({ v: 1, type: "provider_hello" }));
    expect(onMessage).toHaveBeenCalledWith("peer1", { v: 1, type: "provider_hello" });

    node.emit(EVENT_PEER_CONNECTED, "peer2", null);
    expect(onPeerConnected).toHaveBeenCalledWith("peer2");

    node.emit(EVENT_PEER_DISCONNECTED, "peer2", null);
    expect(onPeerDisconnected).toHaveBeenCalledWith("peer2");
  });

  it("coerces ArrayBuffer raw payloads before decoding", async () => {
    const node = new FakeMistNode("n1");
    const onMessage = vi.fn();
    const network = new Network({ createNode: () => node, nodeId: "n1", callbacks: { onMessage } });
    await network.join("room1");

    const bytes = encode({ v: 1, type: "consumer_hello" });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    node.emit(EVENT_RAW, "peer1", buffer);
    expect(onMessage).toHaveBeenCalledWith("peer1", { v: 1, type: "consumer_hello" });
  });

  it("silently drops raw payloads that fail to decode", async () => {
    const node = new FakeMistNode("n1");
    const onMessage = vi.fn();
    const network = new Network({ createNode: () => node, nodeId: "n1", callbacks: { onMessage } });
    await network.join("room1");

    node.emit(EVENT_RAW, "peer1", new Uint8Array([0xff, 0xfe, 0x00]));
    node.emit(EVENT_RAW, "peer1", new TextEncoder().encode('{"v":1,"type":"evil"}'));
    node.emit(EVENT_RAW, "peer1", 42);
    node.emit(EVENT_RAW, "peer1", null);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("send() encodes via the protocol and always uses DELIVERY_RELIABLE", async () => {
    const node = new FakeMistNode("n1");
    const network = new Network({ createNode: () => node, nodeId: "n1" });
    await network.join("room1");

    const msg: ProtocolMessage = { v: 1, type: "llm_error", id: "x", message: "boom" };
    network.send("peer1", msg);
    network.send(null, { v: 1, type: "provider_hello" });

    expect(node.sentMessages()).toEqual([
      { toId: "peer1", msg, delivery: DELIVERY_RELIABLE },
      { toId: null, msg: { v: 1, type: "provider_hello" }, delivery: DELIVERY_RELIABLE },
    ]);
  });

  it("send() is a no-op before join / after leave", () => {
    const node = new FakeMistNode("n1");
    const network = new Network({ createNode: () => node, nodeId: "n1" });
    network.send("peer1", { v: 1, type: "provider_hello" });
    expect(node.sent).toHaveLength(0);
  });

  it("leaves immediately when destroyed mid-init and never joins the room", async () => {
    const node = new SlowInitFakeMistNode("n1");
    const network = new Network({ createNode: () => node, nodeId: "n1" });
    const joinPromise = network.join("room1");

    network.destroy();
    node.releaseInit();
    await joinPromise;

    expect(node.leaveCount).toBe(1);
    expect(node.joinedRooms).toEqual([]);
    expect(network.currentRoomId).toBeNull();
  });

  it("ignores events from a node that has been replaced or destroyed", async () => {
    const node = new FakeMistNode("n1");
    const onMessage = vi.fn();
    const network = new Network({ createNode: () => node, nodeId: "n1", callbacks: { onMessage } });
    await network.join("room1");
    network.destroy();

    node.emit(EVENT_RAW, "peer1", encode({ v: 1, type: "provider_hello" }));
    expect(onMessage).not.toHaveBeenCalled();
  });
});

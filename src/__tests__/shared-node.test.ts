import { describe, expect, it } from "vitest";
import { createSharedNodeScope } from "../shared-node.js";
import { FakeMistNode } from "./fake-node.js";

describe("createSharedNodeScope", () => {
  it("multiplexes every handle in a scope onto one real node (first nodeId wins)", async () => {
    const realNodes: FakeMistNode[] = [];
    const createNode = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodes.push(node);
      return node;
    });

    const handleA = createNode("id-a");
    await handleA.init();
    const handleB = createNode("id-b"); // divergent id — ignored; scope stays on id-a's real node
    await handleB.init();

    expect(realNodes).toHaveLength(1);
    expect(realNodes[0].nodeId).toBe("id-a");
  });

  it("fans out events to every live handle, filtered by the rooms each handle joined", async () => {
    const realNodes: FakeMistNode[] = [];
    const createNode = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodes.push(node);
      return node;
    });

    const consumerHandle = createNode("shared-id");
    const providerHandle = createNode("shared-id");
    await consumerHandle.init();
    await providerHandle.init();

    consumerHandle.joinRoom("roomA");
    providerHandle.joinRoom("roomB");

    const consumerEvents: unknown[] = [];
    const providerEvents: unknown[] = [];
    consumerHandle.onEvent((eventType, fromId, payload) => consumerEvents.push({ eventType, fromId, payload }));
    providerHandle.onEvent((eventType, fromId, payload) => providerEvents.push({ eventType, fromId, payload }));

    const realNode = realNodes[0];
    // Dispatch an event tagged with roomA — only the consumer handle joined it.
    realNode.emit(0, "peer1", "hello-a", "roomA");
    expect(consumerEvents).toEqual([{ eventType: 0, fromId: "peer1", payload: "hello-a" }]);
    expect(providerEvents).toEqual([]);

    // Dispatch an event tagged with roomB — only the provider handle joined it.
    realNode.emit(0, "peer2", "hello-b", "roomB");
    expect(consumerEvents).toEqual([{ eventType: 0, fromId: "peer1", payload: "hello-a" }]);
    expect(providerEvents).toEqual([{ eventType: 0, fromId: "peer2", payload: "hello-b" }]);

    // An event with no roomId at all is defensively delivered to every handle.
    realNode.emit(5, "peer3", null, undefined);
    expect(consumerEvents).toHaveLength(2);
    expect(providerEvents).toHaveLength(2);
  });

  it("reference-counts rooms across handles: leaving one handle's room doesn't evict a room-mate", async () => {
    const realNodes: FakeMistNode[] = [];
    const createNode = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodes.push(node);
      return node;
    });

    const consumerHandle = createNode("shared-id");
    const providerHandle = createNode("shared-id");
    await consumerHandle.init();
    await providerHandle.init();

    consumerHandle.joinRoom("room1");
    providerHandle.joinRoom("room1"); // same room, two handles

    const realNode = realNodes[0];
    expect(realNode.joinedRooms).toEqual(["room1", "room1"]);

    // Consumer leaves the shared room — refcount drops from 2 to 1, so the
    // real node must NOT actually leave the room (provider still needs it).
    consumerHandle.leaveRoom("room1");
    expect(realNode.leaveCount).toBe(0);

    // Provider now leaves too — refcount hits 0, so the real per-room leave fires.
    providerHandle.leaveRoom("room1");
    expect(realNode.leaveCount).toBe(1);
  });

  it("leaveRoom(roomId) drops only that one room; the handle keeps receiving events for its other rooms", async () => {
    const realNodes: FakeMistNode[] = [];
    const createNode = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodes.push(node);
      return node;
    });

    const handle = createNode("shared-id");
    await handle.init();
    handle.joinRoom("roomA");
    handle.joinRoom("roomB");

    const events: unknown[] = [];
    handle.onEvent((eventType, fromId, payload) => events.push({ eventType, fromId, payload }));

    handle.leaveRoom("roomA");
    expect(realNodes[0].leaveCount).toBe(1);

    const realNode = realNodes[0];
    realNode.emit(0, "peer1", "still-in-b", "roomB");
    expect(events).toEqual([{ eventType: 0, fromId: "peer1", payload: "still-in-b" }]);

    realNode.emit(0, "peer1", "no-longer-in-a", "roomA");
    expect(events).toHaveLength(1); // unchanged — roomA event doesn't reach this handle anymore
  });

  it("argless leaveRoom() releases every room the handle joined, matching the pre-widening MistNodeLike shape", async () => {
    const realNodes: FakeMistNode[] = [];
    const createNode = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodes.push(node);
      return node;
    });

    const handle = createNode("shared-id");
    await handle.init();
    handle.joinRoom("roomA");
    handle.joinRoom("roomB");

    handle.leaveRoom(); // no roomId — leaves both
    expect(realNodes[0].leaveCount).toBe(2);

    const events: unknown[] = [];
    handle.onEvent((eventType, fromId, payload) => events.push({ eventType, fromId, payload }));
    realNodes[0].emit(0, "peer1", "late", "roomA");
    expect(events).toEqual([]); // handle removed itself from the live set
  });

  it("never calls the real node's argless leaveRoom(), even when a room's refcount hits zero", async () => {
    let leaveCalls: Array<string | undefined> = [];
    class TrackingFakeMistNode extends FakeMistNode {
      override leaveRoom(roomId?: string): void {
        leaveCalls.push(roomId);
        super.leaveRoom(roomId);
      }
    }
    const createNode = createSharedNodeScope((nodeId) => new TrackingFakeMistNode(nodeId));
    const handle = createNode("shared-id");
    await handle.init();
    handle.joinRoom("room1");
    handle.leaveRoom("room1");
    handle.joinRoom("room2");
    handle.leaveRoom(); // argless on the HANDLE — must still pass an explicit roomId to the real node

    expect(leaveCalls).toEqual(["room1", "room2"]);
    expect(leaveCalls.every((id) => id !== undefined)).toBe(true);
  });

  it("keeps two independently created scopes fully isolated from each other", async () => {
    const realNodesX: FakeMistNode[] = [];
    const realNodesY: FakeMistNode[] = [];
    const createNodeX = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodesX.push(node);
      return node;
    });
    const createNodeY = createSharedNodeScope((nodeId) => {
      const node = new FakeMistNode(nodeId);
      realNodesY.push(node);
      return node;
    });

    await createNodeX("id-x").init();
    await createNodeY("id-y").init();

    expect(realNodesX).toHaveLength(1);
    expect(realNodesY).toHaveLength(1);
    expect(realNodesX[0]).not.toBe(realNodesY[0]);
  });
});

// Public entry point for @tik-choco/mistai/identity — DID delegation chains
// (root -> leaf) for identifying the same person across origins/devices. See
// protocol/docs/data-contracts/docs/did-delegation.md for the full spec.
// Kept out of the package's root index.ts on purpose (like llm-config.ts):
// it exports id.ts-shaped helpers (stableStringify, various parse* helpers)
// whose names would otherwise collide or be confusing next to ./id.ts's own
// randomId/getPersistentNodeId.
export * from "./stableStringify.js";
export * from "./didKey.js";
export * from "./delegation.js";
export * from "./store.js";
export * from "./wire.js";
export * from "./pairing.js";

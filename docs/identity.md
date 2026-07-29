# Portable identity — `@tik-choco/mistai/identity`

DID delegation chains. A permanent "root" identity signs a short-lived authorization for an
origin-local "leaf" key, so peers can recognize the same person across origins and devices without
anyone sharing a raw private key.

Design constraints, so you know what you are not getting:

- Chain depth is fixed at 1 (root → leaf). No sub-delegation.
- There is no revocation list. Delegations expire and get reissued.
- Every receive-side check is backward compatible: a wire with no `delegation` field, or a peer
  that has never heard of delegation chains, behaves exactly as before.

Not re-exported from the package root. `did:key` generation and signing live in `didKey.ts`,
deliberately separate from the core's `id.ts` so `randomId` / `getPersistentNodeId` don't collide
with the identity helpers.

## Modules

- **didKey** — `PublicDidIdentity` / `DidIdentity` types, `createDidIdentity()` /
  `publicDidIdentity()` / `parseStoredDidIdentity()`, `signStringWithDidIdentity()` /
  `verifyStringWithDid()`, and the did:key codec (`didKeyFromEd25519PublicKey`,
  `didKeyFromPublicKeyMultibase`, `ed25519PublicKeyFromDidKey`, `isEd25519DidKey`,
  `publicKeyMultibaseFromEd25519`). No localStorage access — that is `store`'s job.
- **delegation** — `DelegationV1`, `signDelegation(rootIdentity, leaf, { ttlMs?, now? })` (default
  TTL 60 days), `verifyDelegation(delegation, { now?, leaf? })`, `parseDelegation(raw)` (shape
  only, no signature check — for a pasted or manually transferred value),
  `delegationSigningPayload(d)`.

  `verifyDelegation` checks all eight rules: shape, both ends are Ed25519 did:keys,
  `root !== leaf`, `iat < exp`, lifetime ≤ 400 days, ±5 min clock skew, valid signature, and — when
  `leaf` is passed — an exact leaf match.
- **store** — `SHARED_DELEGATION_KEY` (`tc-shared-did-delegation-v1`, a cross-app co-owned
  localStorage key with the same last-write-wins pattern as the shared LLM config),
  `loadDelegation()` / `saveDelegation()` / `clearDelegation()`, `loadDelegationFor(leaf)`
  (verified read), `subscribeDelegation(cb)` (cross-tab `storage` event).

  `loadDelegationFor` returns the stored delegation only if it verifies for `leaf`. A broken,
  expired or foreign-leaf value is ignored **without** clearing the key, since it may belong to a
  different leaf sharing the origin.
- **wire** — `signWireWithDelegation(fields, identity, delegation?)` (attaches `delegation`
  *before* signing, so the delegation is protected by the signature too), `verifyWire(wire)`
  (signature only — the delegation-unaware baseline check), `resolveWireSender(wire, { now? })` →
  `ResolvedSender | null`.

  `resolveWireSender` returns `null` only if the wire's own signature fails. A broken delegation
  degrades to the leaf identity rather than dropping the message.
- **pairing** — the browser side of code-based pairing, where the root custodian issues a
  delegation over a throwaway room derived from a short code.
  `normalizePairingCode(input)` / `formatPairingCode(code)` / `generatePairingCode()`,
  `pairingRoomId(code)` / `pairingMacKey(code)` / `computePairingMac(msg, macKey)`, and
  `requestDelegation({ code, leaf, app, createNode, timeoutMs?, resendIntervalMs? })`.

  `requestDelegation` joins the derived room, resends a MAC'd request every 3 s (default) until a
  MAC-valid response or an error arrives or 60 s (default) elapses, and always leaves the room
  before settling either way. The room-id and MAC-key derivations are kept byte-compatible with the
  Rust implementation through cross-implementation test vectors.

## Typical flow

```ts
import { ensureDidIdentity } from './crypto/didIdentity.js' // the app's own leaf identity
import {
  loadDelegationFor, saveDelegation, requestDelegation,
  signWireWithDelegation, resolveWireSender,
} from '@tik-choco/mistai/identity'

// 1. Receive a delegation once, by pairing code or pasted from the root custodian.
const leaf = await ensureDidIdentity()
saveDelegation(await requestDelegation({
  code: userTypedCode,
  leaf: leaf.did,
  app: 'my-app',
  createNode: (id) => new MistNode(id),
}))

// 2. Attach it whenever signing an outgoing wire.
const delegation = await loadDelegationFor(leaf.did)
const wire = await signWireWithDelegation({ fromId: leaf.did, ...fields }, leaf, delegation)

// 3. Resolve the sender on receive — root when delegated, else leaf.
const sender = await resolveWireSender(wire)
if (sender) recordAuthor(sender.id) // same person across origins when delegated
```

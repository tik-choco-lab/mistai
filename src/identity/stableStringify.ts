// Deterministic JSON used as the signing payload for every identity/wire
// structure in this module (DID identities, DelegationV1, pairing MACs,
// signed wires). Ported verbatim from tc-chat/src/lib/wireSign.ts, which is
// itself the canonical stableStringify for the tik-choco wire format (see
// protocol/docs/data-contracts/docs/global-articles-wire.md) — key-sorted,
// `undefined` fields dropped, so two peers serializing the same logical
// object always produce the same bytes regardless of property insertion
// order.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

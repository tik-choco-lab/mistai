// Chunked base64 helpers for shuttling audio over the JSON wire protocol.
// The mist reliable data channel is only safe for ~16KB per message
// (HAVE_CHUNK_SIZE in mistlib), so audio is base64-encoded and split into
// sub-chunks that fit under that ceiling. The channel is ordered, so the
// receiver reassembles by concatenating chunks in seq order.
//
// Ported from tc-translate/src/lib/mistllm/base64.ts. blobToBase64 is
// implemented with a manual base64 encoder (instead of FileReader/btoa) so it
// works identically in browsers and plain Node.

export const VOICE_CHUNK_SIZE = 12 * 1024; // base64 chars per wire message

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "=" : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "=" : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(bytes);
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function chunkBase64(base64: string, size = VOICE_CHUNK_SIZE): string[] {
  if (base64.length === 0) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < base64.length; i += size) chunks.push(base64.slice(i, i + size));
  return chunks;
}

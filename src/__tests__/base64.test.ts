import { describe, expect, it } from "vitest";
import { VOICE_CHUNK_SIZE, base64ToBlob, blobToBase64, chunkBase64 } from "../base64.js";

describe("base64 helpers", () => {
  it("exposes the expected chunk size", () => {
    expect(VOICE_CHUNK_SIZE).toBe(12 * 1024);
  });

  it("chunkBase64 splits and re-joins losslessly", () => {
    const input = "A".repeat(VOICE_CHUNK_SIZE * 2 + 100);
    const chunks = chunkBase64(input);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(VOICE_CHUNK_SIZE);
    expect(chunks[2]).toHaveLength(100);
    expect(chunks.join("")).toBe(input);
  });

  it("chunkBase64 supports a custom size", () => {
    expect(chunkBase64("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });

  it("chunkBase64 returns [''] for the empty string", () => {
    expect(chunkBase64("")).toEqual([""]);
  });

  it("blobToBase64 / base64ToBlob round-trip preserves bytes and mime", async () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 31) % 256;
    const blob = new Blob([bytes], { type: "audio/mpeg" });

    const base64 = await blobToBase64(blob);
    const back = base64ToBlob(base64, "audio/mpeg");

    expect(back.type).toBe("audio/mpeg");
    expect(new Uint8Array(await back.arrayBuffer())).toEqual(bytes);
  });

  it("blobToBase64 matches the standard base64 alphabet incl. padding", async () => {
    // "Man" -> "TWFu", "Ma" -> "TWE=", "M" -> "TQ==" (RFC 4648 test vectors)
    const enc = new TextEncoder();
    expect(await blobToBase64(new Blob([enc.encode("Man")]))).toBe("TWFu");
    expect(await blobToBase64(new Blob([enc.encode("Ma")]))).toBe("TWE=");
    expect(await blobToBase64(new Blob([enc.encode("M")]))).toBe("TQ==");
    expect(await blobToBase64(new Blob([])) ).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { MistaiError } from "../errors.js";
import { MESSAGES_EN, MESSAGES_JA, formatMistaiCode, formatMistaiError } from "../messages.js";

describe("message catalogs", () => {
  it("maps a coded error through the catalog", () => {
    const err = new MistaiError("PROVIDER_NOT_FOUND", "No provider found on the LLM Network.");
    expect(formatMistaiError(err, MESSAGES_JA)).toBe("プロバイダーが見つかりません。");
    expect(formatMistaiError(err, MESSAGES_EN)).toBe("No provider found on the LLM Network.");
  });

  it("shows REMOTE_ERROR messages as-is (remote-authored), with a catalog fallback when empty", () => {
    expect(formatMistaiError(new MistaiError("REMOTE_ERROR", "boom from provider"), MESSAGES_JA)).toBe(
      "boom from provider",
    );
    expect(formatMistaiError(new MistaiError("REMOTE_ERROR", ""), MESSAGES_JA)).toBe(
      MESSAGES_JA.errors.REMOTE_ERROR,
    );
  });

  it("keeps plain Error messages and falls back for non-Error values", () => {
    expect(formatMistaiError(new Error("plain"), MESSAGES_JA)).toBe("plain");
    expect(formatMistaiError("nope", MESSAGES_JA, "fallback!")).toBe("fallback!");
  });

  it("formatMistaiCode resolves codes and passes undefined through", () => {
    expect(formatMistaiCode("JOIN_FAILED", MESSAGES_JA)).toBe("Room への接続に失敗しました。");
    expect(formatMistaiCode(undefined, MESSAGES_JA)).toBeUndefined();
  });
});

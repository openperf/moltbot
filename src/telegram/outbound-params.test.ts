import { describe, expect, it } from "vitest";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";

describe("parseTelegramReplyToMessageId", () => {
  it("parses a valid positive integer string", () => {
    expect(parseTelegramReplyToMessageId("123")).toBe(123);
  });

  it("parses a large message id", () => {
    expect(parseTelegramReplyToMessageId("9999999")).toBe(9999999);
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
    expect(parseTelegramReplyToMessageId(undefined)).toBeUndefined();
    expect(parseTelegramReplyToMessageId("")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("   ")).toBeUndefined();
  });

  it("rejects UUID-like strings", () => {
    expect(parseTelegramReplyToMessageId("35ce3628-8ceb-45a6-8092-c021c7e5bd53")).toBeUndefined();
  });

  it("rejects partially numeric strings that parseInt would accept", () => {
    // Number.parseInt("123abc", 10) returns 123 — this must be rejected.
    expect(parseTelegramReplyToMessageId("123abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("12 34")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("0x1A")).toBeUndefined();
  });

  it("rejects negative values", () => {
    expect(parseTelegramReplyToMessageId("-1")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("-999")).toBeUndefined();
  });

  it("rejects zero", () => {
    expect(parseTelegramReplyToMessageId("0")).toBeUndefined();
  });

  it("rejects floating-point strings", () => {
    expect(parseTelegramReplyToMessageId("3.14")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("100.0")).toBeUndefined();
  });

  it("rejects non-numeric strings", () => {
    expect(parseTelegramReplyToMessageId("abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("not-a-number")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("NaN")).toBeUndefined();
  });

  it("trims whitespace before validation", () => {
    expect(parseTelegramReplyToMessageId("  456  ")).toBe(456);
    expect(parseTelegramReplyToMessageId("42 ")).toBe(42);
    expect(parseTelegramReplyToMessageId(" 42")).toBe(42);
  });
});

describe("parseTelegramThreadId", () => {
  it("parses a valid integer string", () => {
    expect(parseTelegramThreadId("271")).toBe(271);
  });

  it("parses a scoped DM thread id", () => {
    expect(parseTelegramThreadId("12345:99")).toBe(99);
  });

  it("parses a numeric value", () => {
    expect(parseTelegramThreadId(42)).toBe(42);
  });

  it("returns undefined for null/undefined", () => {
    expect(parseTelegramThreadId(null)).toBeUndefined();
    expect(parseTelegramThreadId(undefined)).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(parseTelegramThreadId(Number.NaN)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseTelegramThreadId("")).toBeUndefined();
    expect(parseTelegramThreadId("   ")).toBeUndefined();
  });
});

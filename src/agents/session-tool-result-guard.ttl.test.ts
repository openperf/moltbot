import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;

describe("session tool-result guard TTL behavior", () => {
  it("does not insert synthetic toolResult before TTL on non-tool message", () => {
    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { pendingToolResultGraceMs: 30_000 });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    sm.appendMessage(
      asAppendMessage({ role: "assistant", content: [{ type: "text", text: "intermediate" }] }),
    );

    const roles = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as { message: { role: string } }).message.role);

    // No synthetic toolResult should be inserted because call_1 is within grace window.
    expect(roles).toEqual(["assistant", "assistant"]);
  });

  it("restores pending tool calls from disk across session-manager reopen", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-pending-"));
    const sessionFile = join(root, "session.jsonl");

    const sm1 = SessionManager.open(sessionFile);
    installSessionToolResultGuard(sm1, { pendingToolResultGraceMs: 30_000 });

    sm1.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_disk_1", name: "read", arguments: {} }],
      }),
    );

    const pendingFile = `${sessionFile}.pending-tool-calls.json`;
    expect(existsSync(pendingFile)).toBe(true);

    const sm2 = SessionManager.open(sessionFile);
    const guard2 = installSessionToolResultGuard(sm2, { pendingToolResultGraceMs: 30_000 });

    expect(guard2.getPendingIds()).toContain("call_disk_1");
  });

  it("inserts synthetic toolResult after TTL expires", () => {
    vi.useFakeTimers();
    const now = new Date("2026-03-05T10:00:00.000Z");
    vi.setSystemTime(now);

    const sm = SessionManager.inMemory();
    installSessionToolResultGuard(sm, { pendingToolResultGraceMs: 30_000 });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      }),
    );

    vi.advanceTimersByTime(31_000);

    sm.appendMessage(
      asAppendMessage({ role: "assistant", content: [{ type: "text", text: "after timeout" }] }),
    );

    const messages = sm
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as unknown as { message: Record<string, unknown> }).message);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect(messages[1].toolCallId).toBe("call_1");
    expect(messages[1].isError).toBe(true);
    vi.useRealTimers();
  });

  it("selectively flushes only expired entries via TTL path, preserving non-expired ones", () => {
    // This test validates the core selective-flush behavior: when multiple
    // pending tool calls have different ages, a user message (non-tool flow)
    // should only flush the expired ones and leave non-expired ones pending.
    //
    // Strategy: use disk-based persistence to simulate different registration
    // times across two guard installations.  The first guard registers call_old
    // at T+0.  We then create a second guard that restores call_old from disk
    // and registers call_young at T+20s.  At T+31s, a user message triggers
    // the TTL check: call_old (age 31s) is expired, call_young (age 11s) is not.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T10:00:00.000Z"));

    const root = mkdtempSync(join(tmpdir(), "oc-selective-"));
    const sessionFile = join(root, "session.jsonl");
    const pendingFile = `${sessionFile}.pending-tool-calls.json`;

    // Phase 1: Register call_old at T+0.
    const sm1 = SessionManager.open(sessionFile);
    installSessionToolResultGuard(sm1, { pendingToolResultGraceMs: 30_000 });

    sm1.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_old", name: "read", arguments: {} }],
      }),
    );
    expect(existsSync(pendingFile)).toBe(true);

    // Phase 2: Advance to T+20s.  Open a new session manager that restores
    // call_old from disk, then register call_young at T+20s.  Because we use
    // a single assistant message containing only call_young, and call_old is
    // already pending, shouldFlushBeforeNewToolCalls will fire.  To avoid that,
    // we manually edit the pending file to add call_young alongside call_old
    // with a T+20s timestamp, then open a third session manager.
    vi.advanceTimersByTime(20_000);

    // Read the persisted state and inject call_young with T+20s timestamp.
    const raw = JSON.parse(readFileSync(pendingFile, "utf8"));
    raw.items.push({
      id: "call_young",
      name: "write",
      createdAtMs: Date.now(), // T+20s
    });
    raw.updatedAtMs = Date.now();
    writeFileSync(pendingFile, `${JSON.stringify(raw)}\n`, "utf8");

    // Phase 3: Open a fresh session manager that restores both entries.
    const sm2 = SessionManager.open(sessionFile);
    const guard2 = installSessionToolResultGuard(sm2, { pendingToolResultGraceMs: 30_000 });

    expect(guard2.getPendingIds().toSorted()).toEqual(["call_old", "call_young"]);

    // Phase 4: Advance to T+31s.  call_old age = 31s (expired), call_young age = 11s (not expired).
    vi.advanceTimersByTime(11_000);

    // Trigger a user message — this enters the isNonToolFlow path.
    sm2.appendMessage(asAppendMessage({ role: "user", content: "check", timestamp: Date.now() }));

    // call_old should be flushed (expired).
    const messages = sm2
      .getEntries()
      .filter((e) => e.type === "message")
      .map((e) => (e as unknown as { message: Record<string, unknown> }).message);

    const syntheticResults = messages.filter((m) => m.role === "toolResult" && m.isError === true);
    expect(syntheticResults).toHaveLength(1);
    expect(syntheticResults[0].toolCallId).toBe("call_old");

    // call_young should still be pending (not expired, age 11s < 30s).
    expect(guard2.getPendingIds()).toEqual(["call_young"]);

    vi.useRealTimers();
  });

  it("cleans up pending file when all tool calls are resolved", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-pending-cleanup-"));
    const sessionFile = join(root, "session.jsonl");
    const pendingFile = `${sessionFile}.pending-tool-calls.json`;

    const sm = SessionManager.open(sessionFile);
    installSessionToolResultGuard(sm, { pendingToolResultGraceMs: 0 });

    sm.appendMessage(
      asAppendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_cleanup", name: "read", arguments: {} }],
      }),
    );
    expect(existsSync(pendingFile)).toBe(true);

    sm.appendMessage(
      asAppendMessage({
        role: "toolResult",
        toolCallId: "call_cleanup",
        content: [{ type: "text", text: "done" }],
        isError: false,
      }),
    );
    expect(existsSync(pendingFile)).toBe(false);
  });
});

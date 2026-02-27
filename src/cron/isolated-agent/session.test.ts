import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
  evaluateSessionFreshness: vi.fn().mockReturnValue({ fresh: true }),
  resolveSessionResetPolicy: vi.fn().mockReturnValue({ mode: "idle", idleMinutes: 60 }),
}));

import { loadSessionStore, evaluateSessionFreshness } from "../../config/sessions.js";
import { resolveCronSession } from "./session.js";

const NOW_MS = 1_737_600_000_000;

type SessionStore = ReturnType<typeof loadSessionStore>;
type SessionStoreEntry = SessionStore[string];
type MockSessionStoreEntry = Partial<SessionStoreEntry>;

function resolveWithStoredEntry(params?: {
  sessionKey?: string;
  entry?: MockSessionStoreEntry;
  forceNew?: boolean;
  fresh?: boolean;
}) {
  const sessionKey = params?.sessionKey ?? "webhook:stable-key";
  const store: SessionStore = params?.entry
    ? ({ [sessionKey]: params.entry as SessionStoreEntry } as SessionStore)
    : {};
  vi.mocked(loadSessionStore).mockReturnValue(store);
  vi.mocked(evaluateSessionFreshness).mockReturnValue({ fresh: params?.fresh ?? true });

  return resolveCronSession({
    cfg: {} as OpenClawConfig,
    sessionKey,
    agentId: "main",
    nowMs: NOW_MS,
    forceNew: params?.forceNew,
  });
}

describe("resolveCronSession", () => {
  it("preserves modelOverride and providerOverride from existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        modelOverride: "deepseek-v3-4bit-mlx",
        providerOverride: "inferencer",
        thinkingLevel: "high",
        model: "k2p5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBe("deepseek-v3-4bit-mlx");
    expect(result.sessionEntry.providerOverride).toBe("inferencer");
    expect(result.sessionEntry.thinkingLevel).toBe("high");
    // The model field (last-used model) should also be preserved
    expect(result.sessionEntry.model).toBe("k2p5");
  });

  it("handles missing modelOverride gracefully", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:test-job",
      entry: {
        sessionId: "old-session-id",
        updatedAt: 1000,
        model: "claude-opus-4-5",
      },
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
  });

  it("handles no existing session entry", () => {
    const result = resolveWithStoredEntry({
      sessionKey: "agent:main:cron:new-job",
    });

    expect(result.sessionEntry.modelOverride).toBeUndefined();
    expect(result.sessionEntry.providerOverride).toBeUndefined();
    expect(result.sessionEntry.model).toBeUndefined();
    expect(result.isNewSession).toBe(true);
  });

  // New tests for session reuse behavior (#18027)
  describe("session reuse for webhooks/cron", () => {
    it("reuses existing sessionId when session is fresh", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-123",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
        },
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("existing-session-id-123");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
    });

    it("creates new sessionId when session is stale", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "old-session-id",
          updatedAt: NOW_MS - 86_400_000, // 1 day ago
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
          providerOverride: "openai",
          sendPolicy: "allow",
        },
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("old-session-id");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
      expect(result.sessionEntry.providerOverride).toBe("openai");
      expect(result.sessionEntry.sendPolicy).toBe("allow");
    });

    it("creates new sessionId when forceNew is true", () => {
      const result = resolveWithStoredEntry({
        entry: {
          sessionId: "existing-session-id-456",
          updatedAt: NOW_MS - 1000,
          systemSent: true,
          modelOverride: "sonnet-4",
          providerOverride: "anthropic",
        },
        fresh: true,
        forceNew: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("existing-session-id-456");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
      expect(result.sessionEntry.providerOverride).toBe("anthropic");
    });

    it("creates new sessionId when entry exists but has no sessionId", () => {
      const result = resolveWithStoredEntry({
        entry: {
          updatedAt: NOW_MS - 1000,
          modelOverride: "some-model",
        },
      });

      expect(result.sessionEntry.sessionId).toBeDefined();
      expect(result.isNewSession).toBe(true);
      // Should still preserve other fields from entry
      expect(result.sessionEntry.modelOverride).toBe("some-model");
    });
  });

  // Regression tests for #29518 — webhook hooks with explicit sessionKey
  // should be able to reuse sessions when forceNew is false.
  describe("webhook session reuse (#29518)", () => {
    it("reuses session when forceNew is false (sessionReuse enabled)", () => {
      const result = resolveWithStoredEntry({
        sessionKey: "hook:my-stable-key",
        entry: {
          sessionId: "webhook-session-abc",
          updatedAt: NOW_MS - 5000,
          systemSent: true,
          modelOverride: "gpt-4.1-mini",
        },
        forceNew: false,
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).toBe("webhook-session-abc");
      expect(result.isNewSession).toBe(false);
      expect(result.systemSent).toBe(true);
      expect(result.sessionEntry.modelOverride).toBe("gpt-4.1-mini");
    });

    it("creates new session when forceNew is true (no sessionReuse)", () => {
      const result = resolveWithStoredEntry({
        sessionKey: "hook:auto-generated-uuid",
        entry: {
          sessionId: "webhook-session-def",
          updatedAt: NOW_MS - 5000,
          systemSent: true,
        },
        forceNew: true,
        fresh: true,
      });

      expect(result.sessionEntry.sessionId).not.toBe("webhook-session-def");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
    });

    it("creates new session when forceNew is false but session is stale", () => {
      const result = resolveWithStoredEntry({
        sessionKey: "hook:my-stable-key",
        entry: {
          sessionId: "webhook-session-old",
          updatedAt: NOW_MS - 86_400_000,
          systemSent: true,
          modelOverride: "sonnet-4",
        },
        forceNew: false,
        fresh: false,
      });

      expect(result.sessionEntry.sessionId).not.toBe("webhook-session-old");
      expect(result.isNewSession).toBe(true);
      expect(result.systemSent).toBe(false);
      // Overrides should still be preserved
      expect(result.sessionEntry.modelOverride).toBe("sonnet-4");
    });
  });
});

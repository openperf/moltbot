import { describe, expect, it } from "vitest";
import { evaluateRuntimeEligibility } from "./config-eval.js";

describe("evaluateRuntimeEligibility", () => {
  it("rejects entries when required OS does not match local or remote", () => {
    const result = evaluateRuntimeEligibility({
      os: ["definitely-not-a-runtime-platform"],
      remotePlatforms: [],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("accepts entries when remote platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("bypasses runtime requirements when always=true", () => {
    const result = evaluateRuntimeEligibility({
      always: true,
      requires: { env: ["OPENAI_API_KEY"] },
      hasBin: () => false,
      hasEnv: () => false,
      isConfigPathTruthy: () => false,
    });
    expect(result).toBe(true);
  });

  it("evaluates runtime requirements when always is false", () => {
    const result = evaluateRuntimeEligibility({
      requires: {
        bins: ["node"],
        anyBins: ["bun", "node"],
        env: ["OPENAI_API_KEY"],
        config: ["browser.enabled"],
      },
      hasBin: (bin) => bin === "node",
      hasAnyRemoteBin: () => false,
      hasEnv: (name) => name === "OPENAI_API_KEY",
      isConfigPathTruthy: (path) => path === "browser.enabled",
    });
    expect(result).toBe(true);
  });

  // --- sandbox eligibility tests ---

  it("accepts entries when sandbox platform satisfies OS requirements", () => {
    const result = evaluateRuntimeEligibility({
      os: ["linux"],
      remotePlatforms: [],
      sandboxPlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("rejects entries when neither local, remote, nor sandbox platform matches OS", () => {
    const result = evaluateRuntimeEligibility({
      os: ["darwin"],
      remotePlatforms: [],
      sandboxPlatforms: ["linux"],
      hasBin: () => true,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("falls back to sandbox bin check when local hasBin returns false (requires.bins)", () => {
    const result = evaluateRuntimeEligibility({
      requires: { bins: ["gh"] },
      hasBin: () => false,
      hasSandboxBin: (bin) => bin === "gh",
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("falls back to sandbox bin check when local hasBin returns false (requires.anyBins)", () => {
    const result = evaluateRuntimeEligibility({
      requires: { anyBins: ["claude", "codex", "pi"] },
      hasBin: () => false,
      hasAnySandboxBin: (bins) => bins.includes("codex"),
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("rejects when bin is missing from local, sandbox, and remote", () => {
    const result = evaluateRuntimeEligibility({
      requires: { bins: ["gh"] },
      hasBin: () => false,
      hasSandboxBin: () => false,
      hasRemoteBin: () => false,
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(false);
  });

  it("checks sandbox before remote for bins (sandbox wins)", () => {
    const calls: string[] = [];
    const result = evaluateRuntimeEligibility({
      requires: { bins: ["gh"] },
      hasBin: () => false,
      hasSandboxBin: (bin) => {
        calls.push(`sandbox:${bin}`);
        return true;
      },
      hasRemoteBin: (bin) => {
        calls.push(`remote:${bin}`);
        return true;
      },
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
    // Sandbox should be checked first; remote should not be reached.
    expect(calls).toEqual(["sandbox:gh"]);
  });

  it("falls through sandbox to remote for bins when sandbox misses", () => {
    const result = evaluateRuntimeEligibility({
      requires: { bins: ["memo"] },
      hasBin: () => false,
      hasSandboxBin: () => false,
      hasRemoteBin: (bin) => bin === "memo",
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });

  it("falls through sandbox to remote for anyBins when sandbox misses", () => {
    const result = evaluateRuntimeEligibility({
      requires: { anyBins: ["claude", "codex"] },
      hasBin: () => false,
      hasAnySandboxBin: () => false,
      hasAnyRemoteBin: (bins) => bins.includes("claude"),
      hasEnv: () => true,
      isConfigPathTruthy: () => true,
    });
    expect(result).toBe(true);
  });
});

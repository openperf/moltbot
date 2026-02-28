import type { SkillEligibilityContext, SkillEntry } from "../agents/skills.js";
import { loadWorkspaceSkillEntries } from "../agents/skills.js";
import { bumpSkillsSnapshotVersion } from "../agents/skills/refresh.js";
import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/skills-sandbox");

/** Cached set of binaries found in the sandbox container/image. */
let cachedBins: Set<string> | null = null;
/** The sandbox image that was used to populate the cache. */
let cachedImage: string | null = null;
/** Platform of the sandbox (always "linux" for Docker containers). */
const SANDBOX_PLATFORM = "linux";
/**
 * Monotonically increasing generation counter.  Each call to
 * `refreshSandboxBinsCache` captures the current generation at the start
 * and only commits results when the generation has not been superseded by
 * a newer invocation.  This prevents a slow, stale refresh from
 * overwriting a more recent result.
 */
let refreshGeneration = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all bins required by skills that could run in the sandbox.
 * Unlike the remote-node variant this does NOT filter by OS because the
 * sandbox is always Linux and we want to know about every binary the
 * sandbox could provide.
 */
function collectRequiredBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    for (const bin of entry.metadata?.requires?.bins ?? []) {
      if (bin.trim()) {
        bins.add(bin.trim());
      }
    }
    for (const bin of entry.metadata?.requires?.anyBins ?? []) {
      if (bin.trim()) {
        bins.add(bin.trim());
      }
    }
  }
  return [...bins];
}

function buildBinProbeScript(bins: string[]): string {
  const escaped = bins.map((bin) => `'${bin.replace(/'/g, `'\\''`)}'`).join(" ");
  return `for b in ${escaped}; do if command -v "$b" >/dev/null 2>&1; then echo "$b"; fi; done`;
}

function parseBinProbeOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function areSetsEqual(a: Set<string> | null, b: Set<string>): boolean {
  if (!a) {
    return false;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const v of b) {
    if (!a.has(v)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Probing (lazy-imports docker to avoid pulling STATE_DIR at module level)
// ---------------------------------------------------------------------------

/**
 * Probe binaries inside a running sandbox container (cheapest path) or
 * fall back to `docker run --rm` against the sandbox image.
 *
 * Returns the list of found binaries, or `null` when probing fails
 * entirely (so the caller can distinguish "nothing found" from "probe
 * error" and preserve a previous cache).
 */
async function probeSandboxBins(
  image: string,
  bins: string[],
  containerName?: string,
): Promise<string[] | null> {
  if (bins.length === 0) {
    return [];
  }

  const { execDockerRaw } = await import("../agents/sandbox/docker.js");
  const script = buildBinProbeScript(bins);

  // 1. Try the running container first (no startup cost).
  if (containerName) {
    try {
      const result = await execDockerRaw(["exec", "-i", containerName, "/bin/sh", "-lc", script], {
        allowFailure: true,
      });
      if (result.code === 0) {
        return parseBinProbeOutput(result.stdout.toString("utf8"));
      }
    } catch {
      // Container not running or unreachable — fall through to image probe.
    }
  }

  // 2. Fall back to a disposable container from the image.
  try {
    const result = await execDockerRaw(
      ["run", "--rm", "--entrypoint", "/bin/sh", image, "-lc", script],
      { allowFailure: true },
    );
    if (result.code === 0) {
      return parseBinProbeOutput(result.stdout.toString("utf8"));
    }
  } catch (err) {
    log.warn(`sandbox bin probe failed for image ${image}: ${String(err)}`);
  }

  // Both paths failed — signal to the caller that probing was unsuccessful.
  return null;
}

// ---------------------------------------------------------------------------
// Config helpers (lazy-imported to avoid pulling in STATE_DIR at module level)
// ---------------------------------------------------------------------------

/**
 * Resolve the sandbox Docker image from config. Returns `undefined` when
 * sandbox mode is disabled.
 */
async function resolveSandboxImage(
  cfg: OpenClawConfig,
  agentId?: string,
): Promise<string | undefined> {
  const { resolveSandboxConfigForAgent } = await import("../agents/sandbox/config.js");
  const { DEFAULT_SANDBOX_IMAGE } = await import("../agents/sandbox/constants.js");
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  if (sandboxCfg.mode === "off") {
    return undefined;
  }
  return sandboxCfg.docker?.image ?? DEFAULT_SANDBOX_IMAGE;
}

/**
 * Attempt to find a running sandbox container for the configured prefix.
 *
 * Sandbox scope defaults to `"agent"` and can also be `"session"` or
 * `"shared"`, so the running container name is not always `…shared`.
 * We use `docker ps --filter name=<prefix>` to find any container whose
 * name starts with the configured prefix, regardless of scope.
 */
async function resolveRunningContainerName(
  cfg: OpenClawConfig,
  agentId?: string,
  expectedImage?: string,
): Promise<string | undefined> {
  const { resolveSandboxConfigForAgent } = await import("../agents/sandbox/config.js");
  const { execDockerRaw } = await import("../agents/sandbox/docker.js");
  const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
  if (sandboxCfg.mode === "off") {
    return undefined;
  }
  const prefix = sandboxCfg.docker?.containerPrefix;
  if (!prefix) {
    return undefined;
  }
  // The browser container prefix (e.g. "openclaw-sbx-browser-") also starts
  // with the tool sandbox prefix (e.g. "openclaw-sbx-"), so we must exclude
  // browser containers to avoid probing the wrong environment.
  const browserPrefix = sandboxCfg.browser?.containerPrefix;
  try {
    // List running containers whose name starts with the configured prefix.
    // Include the image column so we can verify the container runs the
    // expected image and avoid probing a stale or unrelated container.
    const result = await execDockerRaw(
      [
        "ps",
        "--filter",
        `name=^${prefix}`,
        "--filter",
        "status=running",
        "--format",
        "{{.ID}}\t{{.Names}}\t{{.Image}}",
      ],
      { allowFailure: true },
    );
    if (result.code === 0) {
      const lines = result.stdout.toString("utf8").trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const parts = line.split("\t");
        const id = parts[0];
        const name = parts[1];
        const containerImage = parts[2];
        if (!id?.trim()) {
          continue;
        }
        // Skip browser containers.
        if (browserPrefix && name && name.startsWith(browserPrefix)) {
          continue;
        }
        // Skip containers whose image does not match the configured one.
        // This prevents probing bins from a stale container that was
        // started with a different image or runtime setup.
        if (expectedImage && containerImage?.trim() && containerImage.trim() !== expectedImage) {
          continue;
        }
        // If --format gave us the name directly, use it.
        if (name?.trim()) {
          return name.trim();
        }
        // Otherwise resolve the full container name from the short ID.
        const inspectResult = await execDockerRaw(["inspect", "--format", "{{.Name}}", id.trim()], {
          allowFailure: true,
        });
        if (inspectResult.code === 0) {
          const resolved = inspectResult.stdout.toString("utf8").trim().replace(/^\//, "");
          // Double-check the resolved name is not a browser container.
          if (browserPrefix && resolved.startsWith(browserPrefix)) {
            continue;
          }
          return resolved;
        }
        return id.trim();
      }
    }
  } catch {
    // Docker not available or no matching container — fall through.
  }
  return undefined;
}

/**
 * Commit a new cache state and bump the skills snapshot version when the
 * eligibility context has actually changed.
 */
function commitCache(nextBins: Set<string>, image: string): void {
  const changed = cachedImage !== image || !areSetsEqual(cachedBins, nextBins);
  cachedBins = nextBins;
  cachedImage = image;
  if (changed) {
    bumpSkillsSnapshotVersion({ reason: "sandbox" });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Refresh the cached set of binaries available in the sandbox
 * container/image.  Call on gateway startup, whenever sandbox config
 * or skill definitions change, and on config hot-reload.
 *
 * Uses a generation counter to guard against stale results from
 * concurrent fire-and-forget invocations overwriting newer state.
 */
export async function refreshSandboxBinsCache(cfg: OpenClawConfig, agentId?: string) {
  const gen = ++refreshGeneration;

  const image = await resolveSandboxImage(cfg, agentId);
  if (!image) {
    if (gen !== refreshGeneration) {
      return;
    }
    const changed = cachedBins !== null || cachedImage !== null;
    cachedBins = null;
    cachedImage = null;
    if (changed) {
      bumpSkillsSnapshotVersion({ reason: "sandbox" });
    }
    return;
  }

  const workspaceDirs = listAgentWorkspaceDirs(cfg);
  const allBins = new Set<string>();
  for (const dir of workspaceDirs) {
    const entries = loadWorkspaceSkillEntries(dir, { config: cfg });
    for (const bin of collectRequiredBins(entries)) {
      allBins.add(bin);
    }
  }

  if (allBins.size === 0) {
    // No skills require any binaries, but we still need to expose the
    // sandbox platform for OS-only constraints.  Bump the snapshot if
    // this is a transition from a previous state.
    if (gen !== refreshGeneration) {
      return;
    }
    commitCache(new Set(), image);
    return;
  }

  const containerName = await resolveRunningContainerName(cfg, agentId, image);

  // Check generation before the potentially slow Docker probe.
  if (gen !== refreshGeneration) {
    return;
  }

  const found = await probeSandboxBins(image, [...allBins], containerName);

  // When probing fails entirely, keep the previous cache to avoid
  // incorrectly filtering out skills during transient Docker issues —
  // but only when the image has not changed.  If the configured image
  // switched (hot-reload), the old cache is invalid and must not be
  // served under the new image.
  if (found === null) {
    if (cachedBins !== null && cachedImage === image) {
      log.warn("sandbox bin probe failed; keeping previous cache");
      return;
    }
    // Cold start (no prior cache) or image changed — commit an empty
    // set so that the sandbox platform is still reported for OS-only
    // skill constraints.
    log.warn("sandbox bin probe failed on cold start or image change; exposing platform only");
    if (gen !== refreshGeneration) {
      return;
    }
    commitCache(new Set(), image);
    return;
  }

  // Final generation check after the async probe completes.
  if (gen !== refreshGeneration) {
    return;
  }

  commitCache(new Set(found), image);
}

/**
 * Return the sandbox eligibility context for skill filtering, or
 * `undefined` when sandbox mode is off or no bins have been probed yet.
 *
 * Uses strict `=== null` check so that an empty `Set` (probed, but no
 * bins found) still reports the sandbox platform for OS-only constraints.
 */
export function getSandboxSkillEligibility(): SkillEligibilityContext["sandbox"] | undefined {
  if (cachedBins === null) {
    return undefined;
  }
  // Capture the current set in a local constant so that the returned
  // predicate closures remain stable even if a concurrent refresh
  // sets cachedBins to null (e.g. sandbox mode toggled off via hot-reload).
  const snapshotBins = cachedBins;
  return {
    hasBin: (bin) => snapshotBins.has(bin),
    hasAnyBin: (bins) => bins.some((b) => snapshotBins.has(b)),
    platform: SANDBOX_PLATFORM,
  };
}

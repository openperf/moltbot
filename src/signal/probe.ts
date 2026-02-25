import type { BaseProbeResult } from "../channels/plugins/types.js";
import { signalCheck, signalRpcRequest } from "./client.js";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

export async function probeSignal(baseUrl: string, timeoutMs: number): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
  };
  const check = await signalCheck(baseUrl, timeoutMs);

  // When the HTTP request itself succeeds (we got a status code back) but the
  // /api/v1/check endpoint returns a non-2xx response (e.g. 404), the process
  // is still reachable.  Fall back to the JSON-RPC `version` call which works
  // in both REST and JSON-RPC daemon modes of signal-cli.
  if (!check.ok && check.status != null) {
    try {
      const version = await signalRpcRequest("version", undefined, {
        baseUrl,
        timeoutMs,
      });
      const parsedVersion = parseSignalVersion(version);
      return {
        ...result,
        ok: true,
        status: check.status,
        version: parsedVersion,
        elapsedMs: Date.now() - started,
      };
    } catch {
      // JSON-RPC fallback also failed — report original check error.
      return {
        ...result,
        status: check.status,
        error: check.error ?? "unreachable",
        elapsedMs: Date.now() - started,
      };
    }
  }

  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
    });
    result.version = parseSignalVersion(version);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
  };
}

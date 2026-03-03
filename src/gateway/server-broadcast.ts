import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { logWs, shouldLogWs, summarizeAgentEventForWsLog } from "./ws-log.js";

const ADMIN_SCOPE = "operator.admin";
const APPROVALS_SCOPE = "operator.approvals";
const PAIRING_SCOPE = "operator.pairing";

const EVENT_SCOPE_GUARDS: Record<string, string[]> = {
  "exec.approval.requested": [APPROVALS_SCOPE],
  "exec.approval.resolved": [APPROVALS_SCOPE],
  "device.pair.requested": [PAIRING_SCOPE],
  "device.pair.resolved": [PAIRING_SCOPE],
  "node.pair.requested": [PAIRING_SCOPE],
  "node.pair.resolved": [PAIRING_SCOPE],
};

export type GatewayBroadcastStateVersion = {
  presence?: number;
  health?: number;
};

export type GatewayBroadcastOpts = {
  dropIfSlow?: boolean;
  stateVersion?: GatewayBroadcastStateVersion;
};

export type GatewayBroadcastFn = (
  event: string,
  payload: unknown,
  opts?: GatewayBroadcastOpts,
) => void;

export type GatewayBroadcastToConnIdsFn = (
  event: string,
  payload: unknown,
  connIds: ReadonlySet<string>,
  opts?: GatewayBroadcastOpts,
) => void;

function hasAdminScope(client: GatewayWsClient): boolean {
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function hasEventScope(client: GatewayWsClient, event: string): boolean {
  const required = EVENT_SCOPE_GUARDS[event];
  if (!required) {
    return true;
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  if (hasAdminScope(client)) {
    return true;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  return required.some((scope) => scopes.includes(scope));
}

/**
 * Check whether a client should receive a session-scoped chat event.
 *
 * Scoping rules (evaluated in order):
 *  1. Operator clients with `operator.admin` scope always receive all chat
 *     events (Control UI / admin dashboards).
 *  2. Clients that have never interacted via `chat.send` or `chat.history`
 *     (`chatSessionKeys` is undefined or empty) receive all events — this
 *     preserves backward compatibility for existing clients that rely on
 *     client-side sessionKey filtering.
 *  3. If the event carries no `sessionKey` it cannot be scoped — deliver to
 *     all remaining clients.
 *  4. Otherwise, deliver only to clients whose `chatSessionKeys` set contains
 *     the event's sessionKey.
 */
function shouldReceiveChatEvent(client: GatewayWsClient, sessionKey: string | undefined): boolean {
  // Admin-scoped operator clients (e.g., Control UI operators) always see everything.
  const role = client.connect.role ?? "operator";
  if (role === "operator" && hasAdminScope(client)) {
    return true;
  }
  const tracked = client.chatSessionKeys;
  // Clients that haven't declared interest in any session yet get all
  // events — this preserves backward compatibility for existing clients
  // that rely on client-side sessionKey filtering.
  if (!tracked || tracked.size === 0) {
    return true;
  }
  // If the event has no sessionKey we can't scope it — deliver to all.
  if (!sessionKey) {
    return true;
  }
  // Normalize the event key before matching: chat events may be broadcast
  // under a non-canonical alias (e.g. rawSessionKey with mixed case) while
  // the tracked set stores the canonical (lowercased) form, or vice-versa.
  if (tracked.has(sessionKey)) {
    return true;
  }
  const normalized = sessionKey.toLowerCase();
  if (normalized !== sessionKey && tracked.has(normalized)) {
    return true;
  }
  return false;
}

export function createGatewayBroadcaster(params: { clients: Set<GatewayWsClient> }) {
  let seq = 0;

  const broadcastInternal = (
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
    targetConnIds?: ReadonlySet<string>,
  ) => {
    if (params.clients.size === 0) {
      return;
    }
    const isTargeted = Boolean(targetConnIds);
    const eventSeq = isTargeted ? undefined : ++seq;
    const frame = JSON.stringify({
      type: "event",
      event,
      payload,
      seq: eventSeq,
      stateVersion: opts?.stateVersion,
    });
    if (shouldLogWs()) {
      const logMeta: Record<string, unknown> = {
        event,
        seq: eventSeq ?? "targeted",
        clients: params.clients.size,
        targets: targetConnIds ? targetConnIds.size : undefined,
        dropIfSlow: opts?.dropIfSlow,
        presenceVersion: opts?.stateVersion?.presence,
        healthVersion: opts?.stateVersion?.health,
      };
      if (event === "agent") {
        Object.assign(logMeta, summarizeAgentEventForWsLog(payload));
      }
      logWs("out", "event", logMeta);
    }
    // Extract sessionKey from chat event payloads for session-scoped delivery.
    const chatSessionKey =
      event === "chat" && payload && typeof payload === "object" && "sessionKey" in payload
        ? (payload as { sessionKey?: string }).sessionKey
        : undefined;
    for (const c of params.clients) {
      if (targetConnIds && !targetConnIds.has(c.connId)) {
        continue;
      }
      if (!hasEventScope(c, event)) {
        continue;
      }
      // Session-scoped delivery for chat events: skip clients that have
      // declared session interest and are not subscribed to this session.
      if (event === "chat" && !shouldReceiveChatEvent(c, chatSessionKey)) {
        continue;
      }
      const slow = c.socket.bufferedAmount > MAX_BUFFERED_BYTES;
      if (slow && opts?.dropIfSlow) {
        continue;
      }
      if (slow) {
        try {
          c.socket.close(1008, "slow consumer");
        } catch {
          /* ignore */
        }
        continue;
      }
      try {
        c.socket.send(frame);
      } catch {
        /* ignore */
      }
    }
  };

  const broadcast: GatewayBroadcastFn = (event, payload, opts) =>
    broadcastInternal(event, payload, opts);

  const broadcastToConnIds: GatewayBroadcastToConnIdsFn = (event, payload, connIds, opts) => {
    if (connIds.size === 0) {
      return;
    }
    broadcastInternal(event, payload, opts, connIds);
  };

  return { broadcast, broadcastToConnIds };
}

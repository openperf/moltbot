import { describe, expect, it } from "vitest";
import { computeNextRunAtMs } from "./schedule.js";
import { computeJobNextRunAtMs } from "./service/jobs.js";
import type { CronJob } from "./types.js";

const EVERY_24H_MS = 24 * 60 * 60_000;
const ANCHOR_7AM = Date.parse("2026-03-04T07:00:00.000Z");

function createDailyJob(state: CronJob["state"]): CronJob {
  return {
    id: "issue-33940",
    name: "morning-affirmation",
    enabled: true,
    createdAtMs: ANCHOR_7AM,
    updatedAtMs: ANCHOR_7AM,
    schedule: { kind: "every", everyMs: EVERY_24H_MS, anchorMs: ANCHOR_7AM },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "daily affirmation" },
    delivery: { mode: "none" },
    state,
  };
}

describe("Cron issue #33940 manual run schedule drift", () => {
  it("computeJobNextRunAtMs drifts after manual run (demonstrates the bug)", () => {
    // Manual run at 1pm, endedAt just after
    const manualRunAt = Date.parse("2026-03-04T13:00:00.000Z");
    const endedAt = manualRunAt + 5_000;
    const job = createDailyJob({ lastRunAtMs: manualRunAt });

    // computeJobNextRunAtMs uses lastRunAtMs + everyMs = tomorrow 1pm (drifted)
    const driftedNext = computeJobNextRunAtMs(job, endedAt);
    expect(driftedNext).toBe(manualRunAt + EVERY_24H_MS);

    // The correct next run should be tomorrow 7am (anchor-based)
    const correctNext = computeNextRunAtMs(job.schedule, endedAt);
    expect(correctNext).toBe(ANCHOR_7AM + EVERY_24H_MS);

    // Confirm the drift: drifted is 6 hours later than correct
    expect(driftedNext! - correctNext!).toBe(6 * 60 * 60_000);
  });

  it("anchor-based computeNextRunAtMs preserves original schedule after manual run", () => {
    const endedAt = Date.parse("2026-03-04T13:00:05.000Z");

    // Pure anchor-based: next run is tomorrow 7am regardless of when the manual run happened
    const next = computeNextRunAtMs(
      { kind: "every", everyMs: EVERY_24H_MS, anchorMs: ANCHOR_7AM },
      endedAt,
    );
    expect(next).toBe(ANCHOR_7AM + EVERY_24H_MS);
  });

  it("anchor-based schedule is stable across multiple manual runs at different times", () => {
    const schedule = { kind: "every" as const, everyMs: EVERY_24H_MS, anchorMs: ANCHOR_7AM };

    // Manual run at 1pm
    const after1pm = Date.parse("2026-03-04T13:00:05.000Z");
    const next1 = computeNextRunAtMs(schedule, after1pm);

    // Manual run at 10pm
    const after10pm = Date.parse("2026-03-04T22:00:05.000Z");
    const next2 = computeNextRunAtMs(schedule, after10pm);

    // Both should resolve to tomorrow 7am
    expect(next1).toBe(ANCHOR_7AM + EVERY_24H_MS);
    expect(next2).toBe(ANCHOR_7AM + EVERY_24H_MS);
  });

  it("scheduled run still uses lastRunAtMs cadence for minimum interval protection", () => {
    // This verifies that the fix for #22895 is not broken for timer-triggered runs.
    // Scheduled run at 7:04am (4 min late), every 30 min, anchor at 7:00am
    const every30min = 30 * 60_000;
    const anchor = Date.parse("2026-03-04T07:00:00.000Z");
    const scheduledRunAt = Date.parse("2026-03-04T07:04:00.000Z");
    const nowMs = Date.parse("2026-03-04T07:10:00.000Z");

    const job = createDailyJob({ lastRunAtMs: scheduledRunAt });
    // Override schedule for this test
    (job as { schedule: { kind: string; everyMs: number; anchorMs: number } }).schedule = {
      kind: "every",
      everyMs: every30min,
      anchorMs: anchor,
    };

    // computeJobNextRunAtMs should return lastRunAtMs + everyMs = 7:34am
    // (not anchor-based 7:30am which would be only 26 min after last run)
    const next = computeJobNextRunAtMs(job, nowMs);
    expect(next).toBe(scheduledRunAt + every30min);
  });
});

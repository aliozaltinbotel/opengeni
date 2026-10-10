import { describe, expect, mock, test } from "bun:test";
import {
  MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS,
  MODEL_CALL_FACT_RECONCILE_SETTLE_MS,
  MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT,
  createModelCallFactReconcilerActivities,
} from "../src/activities/model-call-fact-reconciler";
import type { ActivityServices } from "../src/activities/types";

const WORKSPACES = Array.from(
  { length: 450 },
  (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
);

function services(info = mock(() => undefined), warn = mock(() => undefined)) {
  return async () =>
    ({ db: {} as never, observability: { info, warn } as never }) as unknown as ActivityServices;
}

const listWorkspaces = async (_db: unknown, input: { afterId: string | null; limit: number }) =>
  WORKSPACES.filter((id) => input.afterId === null || id > input.afterId).slice(0, input.limit);

describe("model call fact reconciler", () => {
  test("visits every workspace once from a random start and reports exact totals", async () => {
    const visited: string[] = [];
    const now = Date.parse("2026-09-25T12:00:00.000Z");
    const info = mock(() => undefined);
    const warn = mock(() => undefined);
    const activity = createModelCallFactReconcilerActivities(services(info, warn), {
      now: () => now,
      startAfterWorkspaceId: () => WORKSPACES[300]!,
      listWorkspaces: listWorkspaces as never,
      reconcileReceipts: async () => ({ settled: 0, truncated: false }),
      reconcile: async (_db, input) => {
        visited.push(input.workspaceId);
        expect(input.until.getTime()).toBe(now - MODEL_CALL_FACT_RECONCILE_SETTLE_MS);
        expect(input.until.getTime() - input.since.getTime()).toBe(
          MODEL_CALL_FACT_RECONCILE_LOOKBACK_MS,
        );
        expect(input.limit).toBe(MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT);
        const missing = input.workspaceId === WORKSPACES[5] ? 3 : 0;
        return {
          missing,
          repaired: missing ? 2 : 0,
          unrepaired: missing ? 1 : 0,
          truncated: input.workspaceId === WORKSPACES[7],
        };
      },
    });
    const result = await activity.reconcileRecentModelCallFacts();
    expect(new Set(visited).size).toBe(WORKSPACES.length);
    expect(visited).toHaveLength(WORKSPACES.length);
    expect(visited[0]).toBe(WORKSPACES[301]);
    expect(visited.at(-1)).toBe(WORKSPACES[300]);
    expect(result).toEqual({
      workspaces: WORKSPACES.length,
      unknownReceiptsSettled: 0,
      missing: 3,
      repaired: 2,
      unrepaired: 1,
      truncatedWorkspaces: 1,
      failedWorkspaces: 0,
      budgetExhausted: false,
    });
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "model call fact reconciliation incomplete",
      expect.objectContaining({ truncatedWorkspaces: 1 }),
    );
  });

  test("installed bounded activity reports unknown receipt recovery separately from known Insights facts", async () => {
    const receipts: string[] = [];
    const info = mock(() => undefined);
    const activity = createModelCallFactReconcilerActivities(services(info), {
      now: () => 0, startAfterWorkspaceId: () => WORKSPACES[0]!,
      listWorkspaces: listWorkspaces as never,
      reconcileReceipts: async (_db, input) => {
        receipts.push(input.workspaceId);
        expect(input.limit).toBe(MODEL_CALL_FACT_RECONCILE_WORKSPACE_LIMIT);
        return { settled: input.workspaceId === WORKSPACES[3] ? 1 : 0, truncated: false };
      },
      reconcile: async () => ({ missing: 0, repaired: 0, unrepaired: 0, truncated: false }),
    });
    const result = await activity.reconcileRecentModelCallFacts();
    expect(new Set(receipts).size).toBe(WORKSPACES.length);
    expect(result).toMatchObject({ unknownReceiptsSettled: 1, repaired: 0, missing: 0 });
    expect(info).toHaveBeenCalledWith("model call fact reconciliation", expect.objectContaining({ unknownReceiptsSettled: 1 }));
  });

  test("isolates a failing workspace and stops at the run budget", async () => {
    let clock = 0;
    const warn = mock(() => undefined);
    const activity = createModelCallFactReconcilerActivities(services(undefined, warn), {
      now: () => clock,
      runBudgetMs: 10,
      startAfterWorkspaceId: () => "00000000-0000-4000-8000-ffffffffffff",
      listWorkspaces: listWorkspaces as never,
      reconcileReceipts: async () => ({ settled: 0, truncated: false }),
      reconcile: async (_db, input) => {
        clock += 1;
        if (input.workspaceId === WORKSPACES[1]) throw new Error("transient");
        return { missing: 0, repaired: 0, unrepaired: 0, truncated: false };
      },
    });
    const result = await activity.reconcileRecentModelCallFacts();
    expect(result).toMatchObject({ workspaces: 10, failedWorkspaces: 1, budgetExhausted: true });
    expect(warn.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "model call fact reconciliation failed for a workspace",
      "model call fact reconciliation incomplete",
    ]);
    expect((warn.mock.calls[0] as unknown[])[1]).toMatchObject({ workspaceId: WORKSPACES[1] });
  });
});

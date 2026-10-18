import { describe, expect, test } from "bun:test";
import type { ModelCallSourceReceipt } from "@opengeni/contracts";
import type { Database } from "@opengeni/db";
import { createAttemptModelSourceDispatch } from "../src/activities/agent-turn/model-source-dispatch";

// The literal dispatch boundary re-checks host source authority every time.
// Only OpenGeni's own re-read of the immutable, digest-bound receipt that this
// attempt just persisted is memoized, and only inside one attempt.

const scope = { accountId: "acct-1", workspaceId: "ws-1", sessionId: "sess-1", turnId: "turn-1", attemptId: "attempt-1" };
const db = {} as Database;

function receipt(overrides: Partial<ModelCallSourceReceipt> = {}): ModelCallSourceReceipt {
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    ...scope,
    executionGeneration: 3,
    sourceKey: "dispatch:source-1",
    requestIndex: 1,
    purpose: "AGENT",
    digest: "a".repeat(64),
    complete: true,
    incompleteReasons: [],
    inputs: [],
    closure: [],
    ...overrides,
  } as unknown as ModelCallSourceReceipt;
}

function harness(options: { generation?: () => number; stored?: ModelCallSourceReceipt | null } = {}) {
  const reads: string[] = [];
  const checks: ModelCallSourceReceipt[] = [];
  let cancelled = 0;
  const dispatch = createAttemptModelSourceDispatch({
    db,
    scope,
    executionGeneration: options.generation ?? (() => 3),
    authorize: async (value) => { checks.push(value); },
    throwIfTurnCancelled: async () => { cancelled++; },
    readReceipt: async (_db, identity) => {
      reads.push(identity.sourceKey);
      return { schema: "cendra.native-source-basis/v1", receipt: options.stored === undefined ? receipt() : options.stored };
    },
  });
  return { dispatch, reads, checks, cancelled: () => cancelled };
}

describe("attempt model-source dispatch", () => {
  test("a receipt persisted in this attempt is not re-read at dispatch; the host check still runs every dispatch", async () => {
    const { dispatch, reads, checks } = harness();
    const persisted = receipt();
    dispatch.retain(persisted);
    await dispatch.beforeProviderDispatch("dispatch:source-1");
    await dispatch.beforeProviderDispatch("dispatch:source-1");
    expect(reads).toEqual([]);
    expect(checks).toEqual([persisted, persisted]);
  });

  test("a source key this attempt did not persist is read from the store", async () => {
    const { dispatch, reads, checks } = harness();
    await dispatch.beforeProviderDispatch("dispatch:source-1");
    expect(reads).toEqual(["dispatch:source-1"]);
    expect(checks).toHaveLength(1);
  });

  test("a retained receipt of an older execution generation is refused before the host check", async () => {
    let generation = 3;
    const { dispatch, checks } = harness({ generation: () => generation });
    dispatch.retain(receipt());
    generation = 4;
    await expect(dispatch.beforeProviderDispatch("dispatch:source-1")).rejects.toThrow("MODEL_SOURCE_RECEIPT_DISPATCH_MISMATCH");
    expect(checks).toHaveLength(0);
  });

  test("receipts of another attempt, turn or generation are never retained", async () => {
    for (const foreign of [{ attemptId: "attempt-2" }, { turnId: "turn-2" }, { executionGeneration: 2 }, { sessionId: "sess-2" }]) {
      const { dispatch, reads } = harness({ stored: null });
      dispatch.retain(receipt(foreign));
      await expect(dispatch.beforeProviderDispatch("dispatch:source-1")).rejects.toThrow("MODEL_SOURCE_RECEIPT_DISPATCH_MISMATCH");
      expect(reads).toEqual(["dispatch:source-1"]);
    }
  });

  test("a second receipt for one source key with another digest is refused", () => {
    const { dispatch } = harness();
    dispatch.retain(receipt());
    expect(() => dispatch.retain(receipt({ digest: "b".repeat(64) }))).toThrow("MODEL_SOURCE_RECEIPT_DIGEST_CONFLICT");
  });

  test("a refused host check propagates and is not remembered", async () => {
    let refuse = true;
    const dispatch = createAttemptModelSourceDispatch({
      db, scope, executionGeneration: () => 3,
      authorize: async () => { if (refuse) throw new Error("authority withdrawn"); },
      throwIfTurnCancelled: async () => undefined,
      readReceipt: async () => { throw new Error("unexpected read"); },
    });
    dispatch.retain(receipt());
    await expect(dispatch.beforeProviderDispatch("dispatch:source-1")).rejects.toThrow("authority withdrawn");
    refuse = false;
    await dispatch.beforeProviderDispatch("dispatch:source-1");
  });

  test("cancellation is checked before and after the host check", async () => {
    const { dispatch, cancelled } = harness();
    dispatch.retain(receipt());
    await dispatch.beforeProviderDispatch("dispatch:source-1");
    expect(cancelled()).toBe(2);
  });
});

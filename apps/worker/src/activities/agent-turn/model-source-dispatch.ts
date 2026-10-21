import type { AuthorizeModelCallSource, ModelCallSourceReceipt } from "@opengeni/contracts";
import { readModelCallSourceReceipt, type Database } from "@opengeni/db";
import { waitForTurnOperation } from "./sandbox-provision";

type AttemptScope = Readonly<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
}>;

/**
 * The literal-dispatch source check of ONE attempt. Create it inside the
 * attempt's activity closure, never at worker scope: its memory dies with the
 * attempt.
 *
 * A source receipt is immutable and digest-bound once committed, so the receipt
 * this attempt has just persisted is kept in memory, keyed by source key and
 * checked against (attempt, execution generation, source key, digest), instead
 * of being read back from the store for every literal dispatch. The host's
 * `authorize` (current authority, liveness and revocation) is never memoized:
 * it runs at every literal dispatch, including every HTTP retry.
 */
export function createAttemptModelSourceDispatch(input: {
  db: Database;
  scope: AttemptScope;
  /** Read at each dispatch: a retry inside the attempt may advance it. */
  executionGeneration: () => number;
  authorize: AuthorizeModelCallSource;
  signal?: AbortSignal;
  throwIfTurnCancelled: () => void | Promise<void>;
  readReceipt?: typeof readModelCallSourceReceipt;
}) {
  const readReceipt = input.readReceipt ?? readModelCallSourceReceipt;
  const { scope } = input;
  const persisted = new Map<string, ModelCallSourceReceipt>();
  const belongsToAttempt = (receipt: ModelCallSourceReceipt, generation: number): boolean =>
    receipt.accountId === scope.accountId &&
    receipt.workspaceId === scope.workspaceId &&
    receipt.sessionId === scope.sessionId &&
    receipt.turnId === scope.turnId &&
    receipt.attemptId === scope.attemptId &&
    receipt.executionGeneration === generation;
  return {
    /** Remember a receipt this attempt committed. A foreign receipt is ignored. */
    retain(receipt: ModelCallSourceReceipt): void {
      if (!belongsToAttempt(receipt, input.executionGeneration())) return;
      const prior = persisted.get(receipt.sourceKey);
      if (prior && prior.digest !== receipt.digest) {
        throw new Error("MODEL_SOURCE_RECEIPT_DIGEST_CONFLICT");
      }
      persisted.set(receipt.sourceKey, receipt);
    },
    beforeProviderDispatch: async (sourceKey: string): Promise<void> => {
      await input.throwIfTurnCancelled();
      const receipt =
        persisted.get(sourceKey) ??
        (
          await readReceipt(input.db, {
            accountId: scope.accountId,
            workspaceId: scope.workspaceId,
            sessionId: scope.sessionId,
            sourceKey,
          })
        ).receipt;
      if (
        !receipt ||
        receipt.turnId !== scope.turnId ||
        receipt.attemptId !== scope.attemptId ||
        receipt.executionGeneration !== input.executionGeneration() ||
        receipt.sourceKey !== sourceKey
      ) {
        throw new Error("MODEL_SOURCE_RECEIPT_DISPATCH_MISMATCH");
      }
      await waitForTurnOperation(
        input.authorize(receipt, input.signal ? { signal: input.signal } : {}),
        input.signal,
        undefined,
      );
      await input.throwIfTurnCancelled();
    },
  };
}

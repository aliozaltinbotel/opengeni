// F-2 (Cendra agent-ops): a declared fallback route applied by the turn recovery transaction, and only as declared.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  metadataWithTurnExecutionPolicyV1,
  metadataWithTurnRouteDeclarationV1,
  readTurnExecutionPolicyV1,
  readTurnRouteDeclarationV1,
  TurnExecutionPolicyV1,
  TurnRouteDeclarationV1,
} from "@opengeni/contracts";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { eq } from "drizzle-orm";
import {
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  getSessionTurn,
  installOrReadTurnExecutionPolicyForAttempt,
  requestSessionTurnRecovery,
  submitHumanPromptInTransaction,
  switchSessionTurnToDeclaredFallback,
  withWorkspaceSessionActivityRls as withWorkspaceRls,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
} from "../src/index";
import * as schema from "../src/schema";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

const acceptedPolicy = TurnExecutionPolicyV1.parse({
  schemaVersion: 1,
  productModelId: "codex/gpt-5.6-sol",
  requestedModelId: "codex/gpt-5.6-sol",
  modelSource: "explicit",
  reasoningEffort: "xhigh",
  reasoningSource: "explicit",
  providerId: "codex-subscription",
  upstreamModelId: "gpt-5.6-sol",
  wireApi: "responses",
  credentialSource: {
    kind: "connected_subscription",
    provider: "codex",
  },
  billing: {
    upstreamPayer: "connected_subscription",
    metering: "external",
  },
  definitionVersion: `sha256:${"a".repeat(64)}`,
});

const fallbackPolicy = TurnExecutionPolicyV1.parse({
  ...acceptedPolicy,
  productModelId: "codex/gpt-5.6-terra",
  requestedModelId: "codex/gpt-5.6-terra",
  reasoningEffort: "low",
  upstreamModelId: "gpt-5.6-terra",
  definitionVersion: `sha256:${"c".repeat(64)}`,
});
const otherPolicy = TurnExecutionPolicyV1.parse({
  ...fallbackPolicy,
  definitionVersion: `sha256:${"d".repeat(64)}`,
});
const declared = (fallback: TurnExecutionPolicyV1 | null) =>
  metadataWithTurnRouteDeclarationV1(
    metadataWithTurnExecutionPolicyV1({}, acceptedPolicy),
    TurnRouteDeclarationV1.parse({ schemaVersion: 1, fallbackPolicy: fallback, turnBudget: null }),
  );

type Fixture = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  sessionId: string;
  turnId: string;
  workflowId: string;
};

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("turn-route-fallback");
  if (!shared) {
    available = false;
    console.warn("[turn-route-fallback] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 900_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture(metadata: Record<string, unknown> = {}): Promise<Fixture> {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `turn-policy-account-${suffix}`,
    accountName: "Turn execution policy test",
    workspaceExternalSource: "test",
    workspaceExternalId: `turn-policy-workspace-${suffix}`,
    workspaceName: "Turn execution policy test",
    subjectId: `turn-policy-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: acceptedPolicy.productModelId,
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  const submitted = await withWorkspaceSubjectRls(
    client.db,
    grant.workspaceId!,
    grant.subjectId,
    (db) =>
      db.transaction((tx) =>
        submitHumanPromptInTransaction(tx as unknown as typeof db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId!,
          sessionId: session.id,
          subjectId: grant.subjectId,
          actor: { type: "human", subjectId: grant.subjectId },
          operationKey: crypto.randomUUID(),
          delivery: "send",
          text: "run with the accepted provider identity",
          resources: [],
          model: acceptedPolicy.productModelId,
          reasoningEffort: acceptedPolicy.reasoningEffort,
          reasoningEffortFallback: "high",
          source: "user",
        }),
      ),
  );
  await withWorkspaceRls(client.db, grant.workspaceId!, async (db) => {
    await db
      .update(schema.sessionTurns)
      .set({ metadata })
      .where(eq(schema.sessionTurns.id, submitted.turnId));
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    turnId: submitted.turnId,
    workflowId: `session-${session.id}`,
  };
}

async function claim(
  value: Fixture,
  options: {
    attemptId?: string;
    trigger?: Parameters<typeof claimSessionWorkForAttempt>[2]["trigger"];
  } = {},
) {
  const attemptId = options.attemptId ?? crypto.randomUUID();
  const result = await claimSessionWorkForAttempt(client.db, value.workspaceId, {
    sessionId: value.sessionId,
    workflowId: value.workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: options.trigger ?? { kind: "next" },
  });
  if (result.action !== "claimed") {
    throw new Error(`Expected claimed turn, received ${result.reason}`);
  }
  return { attemptId, turn: result.turn };
}

async function install(
  value: Fixture,
  claimed: Awaited<ReturnType<typeof claim>>,
  policyForAbsent = acceptedPolicy,
) {
  return await installOrReadTurnExecutionPolicyForAttempt(client.db, {
    accountId: value.accountId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    executionGeneration: claimed.turn.executionGeneration,
    attemptId: claimed.attemptId,
    policyForAbsent,
  });
}

describe("F-2 declared fallback in the turn recovery", () => {
  const recover = (
    value: Fixture,
    claimed: Awaited<ReturnType<typeof claim>>,
    policy: TurnExecutionPolicyV1,
  ) =>
    requestSessionTurnRecovery(client.db, value.workspaceId, {
      sessionId: value.sessionId,
      turnId: value.turnId,
      triggerEventId: claimed.turn.triggerEventId,
      attemptId: claimed.attemptId,
      reason: "model_fallback",
      detail: { code: "PRIMARY_REFUSED_FALLBACK_RAN", retryable: true },
      modelFallback: { policy, reason: "http_404:model_not_found" },
    });

  test("the same turn is recovered on the declared fallback: route, policy and the record of which ran", async () => {
    if (!available) return;
    const value = await fixture(declared(fallbackPolicy));
    const first = await claim(value);
    expect(await install(value, first)).toMatchObject({
      accepted: true,
      installed: false,
      policy: acceptedPolicy,
    });
    expect(await recover(value, first, fallbackPolicy)).toMatchObject({ action: "recovering" });
    const turn = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(turn?.model).toBe(fallbackPolicy.productModelId);
    expect(turn?.reasoningEffort).toBe(fallbackPolicy.reasoningEffort);
    expect(readTurnExecutionPolicyV1(turn?.metadata)).toEqual({
      kind: "valid",
      policy: fallbackPolicy,
    });
    const route = readTurnRouteDeclarationV1(turn?.metadata);
    expect(route.kind === "valid" && route.declaration.executed).toBe("fallback");
    expect(route.kind === "valid" && route.declaration.fallbackReason).toBe(
      "http_404:model_not_found",
    );
    // The next attempt claims the fallback as the turn's accepted policy.
    const second = await claim(value);
    expect(await install(value, second)).toMatchObject({
      accepted: true,
      installed: false,
      policy: fallbackPolicy,
    });
    // Never twice.
    expect(await recover(value, second, fallbackPolicy)).toMatchObject({
      action: "not_recoverable",
    });
  });

  test("a policy the turn did not declare, or a turn that declared no fallback, is not recoverable this way", async () => {
    if (!available) return;
    const value = await fixture(declared(fallbackPolicy));
    const first = await claim(value);
    await install(value, first);
    expect(await recover(value, first, otherPolicy)).toMatchObject({ action: "not_recoverable" });
    const turn = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(turn?.model).toBe(acceptedPolicy.productModelId);

    const none = await fixture(declared(null));
    const noneAttempt = await claim(none);
    await install(none, noneAttempt);
    expect(await recover(none, noneAttempt, fallbackPolicy)).toMatchObject({
      action: "not_recoverable",
    });

    const legacy = await fixture(metadataWithTurnExecutionPolicyV1({}, acceptedPolicy));
    const legacyAttempt = await claim(legacy);
    await install(legacy, legacyAttempt);
    expect(await recover(legacy, legacyAttempt, fallbackPolicy)).toMatchObject({
      action: "not_recoverable",
    });
  });
});

describe("NPD-013 declared fallback inside the attempt (no recovery, no generation bump)", () => {
  const switchTo = (
    value: Fixture,
    claimed: Awaited<ReturnType<typeof claim>>,
    policy: TurnExecutionPolicyV1,
    overrides: { attemptId?: string; executionGeneration?: number } = {},
  ) =>
    switchSessionTurnToDeclaredFallback(client.db, value.workspaceId, {
      sessionId: value.sessionId,
      turnId: value.turnId,
      attemptId: overrides.attemptId ?? claimed.attemptId,
      executionGeneration: overrides.executionGeneration ?? claimed.turn.executionGeneration,
      policy,
      reason: "http_404:model_not_found",
    });

  test("the attempt that holds the turn switches it to the declared fallback, once, at the same generation", async () => {
    if (!available) return;
    const value = await fixture(declared(fallbackPolicy));
    const first = await claim(value);
    await install(value, first);
    const switched = await switchTo(value, first, fallbackPolicy);
    expect(switched?.declaration.executed).toBe("fallback");
    expect(switched?.declaration.fallbackReason).toBe("http_404:model_not_found");
    const turn = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(turn?.status).toBe("running");
    expect(turn?.activeAttemptId).toBe(first.attemptId);
    expect(turn?.executionGeneration).toBe(first.turn.executionGeneration);
    expect(turn?.model).toBe(fallbackPolicy.productModelId);
    expect(turn?.reasoningEffort).toBe(fallbackPolicy.reasoningEffort);
    expect(readTurnExecutionPolicyV1(turn?.metadata)).toEqual({
      kind: "valid",
      policy: fallbackPolicy,
    });
    const route = readTurnRouteDeclarationV1(turn?.metadata);
    expect(route.kind === "valid" && route.declaration.executed).toBe("fallback");
    // Never twice.
    expect(await switchTo(value, first, fallbackPolicy)).toBeNull();
  });

  test("refused: another attempt, another generation, an undeclared policy, no declared fallback", async () => {
    if (!available) return;
    const value = await fixture(declared(fallbackPolicy));
    const first = await claim(value);
    await install(value, first);
    expect(
      await switchTo(value, first, fallbackPolicy, { attemptId: crypto.randomUUID() }),
    ).toBeNull();
    expect(
      await switchTo(value, first, fallbackPolicy, {
        executionGeneration: first.turn.executionGeneration + 1,
      }),
    ).toBeNull();
    expect(await switchTo(value, first, otherPolicy)).toBeNull();
    const turn = await getSessionTurn(client.db, value.workspaceId, value.turnId);
    expect(turn?.model).toBe(acceptedPolicy.productModelId);
    const none = await fixture(declared(null));
    const noneAttempt = await claim(none);
    await install(none, noneAttempt);
    expect(await switchTo(none, noneAttempt, fallbackPolicy)).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import {
  GoalSpec,
  GoalContinuationInputAttribution,
  UpdateSessionGoalRequest,
  SessionGoalReportRequirements,
  SessionGoalReportDeliveries,
  SessionGoalSnapshot,
  renderSessionGoalContext,
} from "../src";

const report = { id: "final-report", title: "Final report" };
const delivery = {
  requirementId: report.id,
  artifactId: "1".repeat(32),
  inspectionReceiptId: "11111111-1111-4111-8111-111111111111",
};

describe("typed report declarations and deliveries", () => {
  test("non-report goals stay compatible and direct report requirements survive parsing", () => {
    expect(GoalSpec.parse({ text: "Fix code" }).reportRequirements).toBeUndefined();
    expect(
      GoalSpec.parse({ text: "Write report", reportRequirements: [report] }).reportRequirements,
    ).toEqual([report]);
  });
  test.each(["", "bad id", "../report", "a".repeat(65), "résumé"])(
    "rejects invalid requirement ID %s",
    (id) => {
      expect(SessionGoalReportRequirements.safeParse([{ ...report, id }]).success).toBe(false);
    },
  );
  test("requires IDs, rejects duplicate IDs and bounds titles in UTF-8", () => {
    expect(SessionGoalReportRequirements.safeParse([{ title: "Missing id" }]).success).toBe(false);
    expect(SessionGoalReportRequirements.safeParse([report, report]).success).toBe(false);
    expect(
      SessionGoalReportRequirements.safeParse([{ ...report, title: "é".repeat(257) }]).success,
    ).toBe(false);
    expect(SessionGoalReportRequirements.safeParse([{ ...report, title: "   " }]).success).toBe(
      false,
    );
    expect(
      SessionGoalReportRequirements.safeParse(
        Array.from({ length: 17 }, (_, id) => ({ id: String(id), title: "Report" })),
      ).success,
    ).toBe(false);
  });
  test("accepts only native artifact IDs, receipt IDs, and unique declared delivery IDs", () => {
    expect(SessionGoalReportDeliveries.parse([delivery])).toEqual([delivery]);
    for (const invalid of [
      { ...delivery, artifactId: delivery.inspectionReceiptId },
      { ...delivery, artifactId: "0".repeat(32) },
      { ...delivery, inspectionReceiptId: "user-asserted" },
      { ...delivery, inspected: true },
      { artifactId: delivery.artifactId, inspectionReceiptId: delivery.inspectionReceiptId },
    ])
      expect(SessionGoalReportDeliveries.safeParse([invalid]).success).toBe(false);
    expect(SessionGoalReportDeliveries.safeParse([delivery, delivery]).success).toBe(false);
  });
  test("frozen report declarations are rendered while old snapshots stay readable", () => {
    const legacy = {
      state: "active",
      goalId: delivery.inspectionReceiptId,
      objectiveRevision: 1,
      text: "Report",
      successCriteria: null,
      mutationPolicy: "preserve_intent",
      capturedAt: "2026-09-14T00:00:00Z",
    };
    expect(SessionGoalSnapshot.safeParse(legacy).success).toBe(true);
    const snapshot = SessionGoalSnapshot.parse({ ...legacy, reportRequirements: [report] });
    expect(renderSessionGoalContext(snapshot)).toContain(JSON.stringify([report]));
  });
});

test("conditional goal status requests preserve complete observed pause identity", () => {
  const expectedGoal = { id: delivery.inspectionReceiptId, version: 7, pausedReason: "agent" };
  expect(UpdateSessionGoalRequest.parse({ status: "active", expectedGoal })).toEqual({
    status: "active",
    expectedGoal,
  });
  expect(UpdateSessionGoalRequest.parse({ status: "paused" })).toEqual({ status: "paused" });
  for (const invalid of [
    { ...expectedGoal, version: 0 },
    { ...expectedGoal, version: 1.5 },
    { ...expectedGoal, id: "wrong" },
    { id: expectedGoal.id, version: 7 },
  ])
    expect(
      UpdateSessionGoalRequest.safeParse({ status: "active", expectedGoal: invalid }).success,
    ).toBe(false);
});

test("canonical continuation requires exact agent pause and immutable bounded input", () => {
  const expectedGoal = { id: delivery.inspectionReceiptId, version: 7, pausedReason: "agent" };
  const continuationInput = {
    operationKey: "approved-proposal-1",
    text: "Continue canonical approved work",
  };
  expect(
    UpdateSessionGoalRequest.parse({ status: "active", expectedGoal, continuationInput }),
  ).toEqual({ status: "active", expectedGoal, continuationInput });
  for (const request of [
    { status: "active", continuationInput },
    { status: "paused", expectedGoal, continuationInput },
    ...[null, "api", "limits"].map((pausedReason) => ({
      status: "active",
      expectedGoal: { ...expectedGoal, pausedReason },
      continuationInput,
    })),
    ...[
      { ...continuationInput, text: " " },
      { ...continuationInput, operationKey: "" },
      { ...continuationInput, text: "x".repeat(32769) },
      { ...continuationInput, extra: true },
    ].map((input) => ({ status: "active", expectedGoal, continuationInput: input })),
  ])
    expect(UpdateSessionGoalRequest.safeParse(request).success).toBe(false);
});


test("canonical Goal event attribution is bounded identity without payload or actor data", () => {
  const identity = { operationKey: "canonical-input:1", updateId: delivery.inspectionReceiptId };
  expect(GoalContinuationInputAttribution.parse(identity)).toEqual(identity);
  for (const invalid of [{ ...identity, updateId: "invalid" }, { ...identity, operationKey: "" },
    { ...identity, operationKey: "x".repeat(257) }, { ...identity, text: "continuation payload" },
    { ...identity, subjectId: "synthetic-actor" }]) {
    expect(GoalContinuationInputAttribution.safeParse(invalid).success).toBe(false);
  }
});

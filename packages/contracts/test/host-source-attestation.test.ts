import { expect, test } from "bun:test";
import { signDelegatedAccessToken, verifyDelegatedAccessToken, verifyHostSourceAttestation } from "../src/index";

const claims = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
  turnId: "44444444-4444-4444-8444-444444444444",
  attemptId: "55555555-5555-4555-8555-555555555555",
  executionGeneration: 2, subjectId: "user:owner", principalKind: "agent_attempt" as const,
  permissions: ["workspace:read" as const], exp: 4_102_444_800,
  hostSource: {
    purpose: "HOST_SOURCE" as const, resource: "https://native.invalid/v1/workspaces/22222222-2222-4222-8222-222222222222/mcp",
    serverId: "host", toolName: "prepare", wireToolName: "host__prepare",
    nativeModelSourceKey: "original-source", sourceCallId: "call-original", operationId: "66666666-6666-4666-8666-666666666666",
    connectionSubjectId: "user:owner", inputSha256: "a".repeat(64), credentialSha256: "b".repeat(64),
  },
};

test("host-source evidence cannot authenticate as an ordinary delegated bearer", async () => {
  const token = await signDelegatedAccessToken("test-only-secret", claims);
  expect(await verifyDelegatedAccessToken("test-only-secret", token)).toBeNull();
});

test("host-source purpose is signed and cannot be downgraded or replaced by a general bearer", async () => {
  const token = await signDelegatedAccessToken("test-only-secret", claims);
  expect((await verifyHostSourceAttestation("test-only-secret", token))?.hostSource.sourceCallId).toBe("call-original");
  expect(await verifyDelegatedAccessToken("test-only-secret", token.replace("ogd4_", "ogd_"))).toBeNull();
  expect(await verifyHostSourceAttestation("wrong-key", token)).toBeNull();
  expect(await verifyHostSourceAttestation("test-only-secret", token, claims.exp + 1)).toBeNull();
  const { hostSource, ...ordinary } = claims;
  expect(await verifyHostSourceAttestation("test-only-secret", await signDelegatedAccessToken("test-only-secret", ordinary))).toBeNull();
});

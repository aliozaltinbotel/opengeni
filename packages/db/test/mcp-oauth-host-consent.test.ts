// opengeni:test-shared-postgres-exclusive
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import postgres from "postgres";
import { createDb, type DbClient } from "../src/database";
import {
  freezeMcpOAuthHostProposal,
  admitMcpOAuthHostProposal,
  readMcpOAuthHostProposal,
  consumeMcpOAuthAuthorizationRequest,
} from "../src/mcp-oauth";

setDefaultTimeout(180_000);
let fixtureUrl: string | null = null;
const fixtureDatabase = `q15_consent_${crypto.randomUUID().replaceAll("-", "")}`;
let admin: ReturnType<typeof postgres> | null = null;
let client: DbClient | null = null;
const organizationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const requestHash = "a".repeat(64);
const human = {
  identityId: "33333333-3333-4333-8333-333333333333",
  authSessionId: "session-one",
  loginBindingId: "44444444-4444-4444-8444-444444444444",
  loginBindingRevision: 1,
};
beforeAll(async () => {
  const maintenanceUrl = process.env.OPENGENI_TEST_PG_URL;
  if (!maintenanceUrl) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("real PostgreSQL required");
    return;
  }
  const maintenance = postgres(maintenanceUrl, { max: 1, prepare: false });
  await maintenance.unsafe(`create database "${fixtureDatabase}"`);
  await maintenance.end();
  const url = new URL(maintenanceUrl);
  url.pathname = fixtureDatabase;
  fixtureUrl = url.toString();
  admin = postgres(fixtureUrl, { max: 1, prepare: false });
  // The existing OAuth owner needs only its own tables for the atomic seam.
  await admin.unsafe(`create table mcp_oauth_clients (client_id text primary key, expires_at timestamptz);
    create table mcp_oauth_authorization_requests (
      request_hash text primary key, client_id text, account_id uuid, workspace_id uuid,
      subject_id text, resource text, redirect_uri text, code_challenge text, state text,
      permissions jsonb, tool_identities jsonb, organization_access jsonb, consent_preset text,
      tool_set_versions jsonb, expires_at timestamptz);
    create table workspaces (id uuid primary key, account_id uuid);
    create table workspace_memberships (workspace_id uuid, subject_id text, permissions jsonb);
    insert into workspaces values ('${workspaceId}', '${organizationId}');
    insert into workspace_memberships values ('${workspaceId}', 'user:person', '["workspace:read"]');
    create function list_self_organization_memberships(text) returns jsonb language sql as $$select '[]'::jsonb$$;
    create table mcp_oauth_access_tokens (like mcp_oauth_authorization_requests);
    create table mcp_oauth_refresh_tokens (like mcp_oauth_authorization_requests);
    create table organization_host_command_attributions (
      account_id uuid, operation_id uuid, mutation text, service_subject_id text,
      service_initiator_subject_id text, acting_external_source text, acting_external_id text,
      primary key (account_id, operation_id));
    create table mcp_oauth_authorization_codes (like mcp_oauth_authorization_requests including defaults);
    alter table mcp_oauth_authorization_codes drop column request_hash;
    alter table mcp_oauth_authorization_codes drop column state;
    alter table mcp_oauth_authorization_codes add column code_hash text primary key;
    insert into mcp_oauth_clients values ('client', clock_timestamp() + interval '1 day');
    -- Real identity owners are covered by the API fixture; isolate pending SQL here.
    create function validate_canonical_human_session(text,text,boolean) returns boolean
      language sql as $$select $1 = 'session-one' and $2 = 'person'$$;
    create function get_canonical_human_identity_projection(text) returns jsonb
      language sql as $$select '{"activeIdentity":{"id":"33333333-3333-4333-8333-333333333333","status":"active","activeLoginBindingId":"44444444-4444-4444-8444-444444444444"},"loginBindings":[{"id":"44444444-4444-4444-8444-444444444444","status":"active","revision":1}]}'::jsonb$$;`);
  await admin.unsafe(
    await Bun.file(new URL("../drizzle/1028_mcp_oauth_host_consent.sql", import.meta.url)).text(),
  );
  client = createDb(fixtureUrl);
}, 180_000);
afterAll(async () => {
  await client?.close();
  await admin?.end();
  if (fixtureUrl) {
    const maintenance = postgres(process.env.OPENGENI_TEST_PG_URL!, { max: 1 });
    await maintenance.unsafe(`drop database "${fixtureDatabase}" with (force)`);
    await maintenance.end();
  }
});
async function seed() {
  await admin!
    .unsafe(`delete from mcp_oauth_authorization_requests; delete from mcp_oauth_authorization_codes; delete from organization_host_command_attributions;
    insert into mcp_oauth_authorization_requests (request_hash, client_id, account_id, workspace_id, subject_id, resource, redirect_uri, code_challenge, state, permissions, tool_identities, organization_access, consent_preset, tool_set_versions, expires_at, host_proposal, host_proposal_revision, host_proposal_digest, host_operation_id, host_admitted_at) values (
      '${requestHash}', 'client', '${organizationId}', '${workspaceId}', 'user:person',
      'https://native.example/v1/mcp', 'http://127.0.0.1:4444/callback', '${"x".repeat(43)}', 'state',
      '["workspace:read"]', '[{"serverId":"host","toolName":"read"}]', null, 'read_only', '{"host":"v1"}',
      clock_timestamp() + interval '5 minutes', null, 0, null, null, null
    )`);
}
const freeze = () =>
  freezeMcpOAuthHostProposal(client!.db, {
    requestHash,
    organizationId,
    subjectId: "user:person",
    workspaceId,
    human,
  });
const attributionFor = (operationId: string) => ({
  organizationId,
  operationId,
  mutation: "mcp_connection.create",
  serviceSubjectId: "service:host",
  serviceInitiatorSubjectId: "service:initiator",
  actingExternalUser: { source: "test:host", externalId: "human" },
});
function admissionFor(proposal: NonNullable<Awaited<ReturnType<typeof freeze>>>) {
  return {
    organizationId,
    workspaceId,
    requestHash,
    revision: proposal.revision,
    digest: proposal.digest,
    operationId: proposal.operationId,
    attribution: attributionFor(proposal.operationId),
  };
}
describe("durable host admission on the existing OAuth request", () => {
  test("HOST admission is exact, replayable and consumed with native consent once", async () => {
    if (!client) return;
    await seed();
    const proposal = await freeze();
    expect(proposal).not.toBeNull();
    const again = await freeze();
    expect(again).toEqual(proposal);
    expect(await readMcpOAuthHostProposal(client.db, { organizationId, requestHash })).toEqual({
      ...proposal!,
      admitted: false,
    });
    const input = admissionFor(proposal!);
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("admitted");
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("replayed");
    expect(
      await admitMcpOAuthHostProposal(client.db, { ...input, operationId: crypto.randomUUID() }),
    ).toBe("conflict");
    const consumed = await consumeMcpOAuthAuthorizationRequest(client.db, {
      requestHash,
      subjectId: "user:person",
      codeHash: "b".repeat(64),
      codeExpiresAt: new Date(Date.now() + 60_000),
      hostAdmission: input,
      hostBrowserAuthUserId: "person",
    });
    expect(consumed?.clientId).toBe("client");
    expect(
      await consumeMcpOAuthAuthorizationRequest(client.db, {
        requestHash,
        subjectId: "user:person",
        codeHash: "c".repeat(64),
        codeExpiresAt: new Date(Date.now() + 60_000),
        hostAdmission: input,
        hostBrowserAuthUserId: "person",
      }),
    ).toBeNull();
  });
  test("callback success without admission and foreign organization cannot consume", async () => {
    if (!client) return;
    await seed();
    const proposal = await freeze();
    const input = admissionFor(proposal!);
    expect(
      await consumeMcpOAuthAuthorizationRequest(client.db, {
        requestHash,
        subjectId: "user:person",
        codeHash: "b".repeat(64),
        codeExpiresAt: new Date(Date.now() + 60_000),
        hostAdmission: input,
        hostBrowserAuthUserId: "person",
      }),
    ).toBeNull();
    expect(
      await readMcpOAuthHostProposal(client.db, { organizationId: workspaceId, requestHash }),
    ).toBeNull();
    expect(
      await admitMcpOAuthHostProposal(client.db, { ...input, organizationId: workspaceId }),
    ).toBe("conflict");
  });
  test("changed scope or human invalidates admission and conflicts with its old operation", async () => {
    if (!client) return;
    await seed();
    const initial = await freeze();
    const input = admissionFor(initial!);
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("admitted");
    await admin!`update mcp_oauth_authorization_requests set permissions = '["workspace:read","files:read"]'::jsonb where request_hash = ${requestHash}`;
    const changed = await freeze();
    expect(changed!.revision).toBe(initial!.revision + 1);
    expect(changed!.operationId).not.toBe(initial!.operationId);
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("conflict");
    expect(
      (await readMcpOAuthHostProposal(client.db, { organizationId, requestHash }))!.admitted,
    ).toBe(false);
    const rebound = await freezeMcpOAuthHostProposal(client.db, {
      requestHash,
      organizationId,
      subjectId: "user:person",
      workspaceId,
      human: { ...human, loginBindingRevision: 2 },
    });
    expect(rebound!.revision).toBe(changed!.revision + 1);
    expect(
      await consumeMcpOAuthAuthorizationRequest(client.db, {
        requestHash,
        subjectId: "user:person",
        codeHash: "b".repeat(64),
        codeExpiresAt: new Date(Date.now() + 60_000),
        hostAdmission: input,
        hostBrowserAuthUserId: "person",
      }),
    ).toBeNull();
  });
  test("concurrent admission and consumption commit once, and the consumed request cannot be readmitted", async () => {
    if (!client) return;
    await seed();
    const proposal = await freeze();
    const input = admissionFor(proposal!);
    const outcomes = await Promise.all([
      admitMcpOAuthHostProposal(client.db, input),
      admitMcpOAuthHostProposal(client.db, input),
    ]);
    expect(outcomes.sort()).toEqual(["admitted", "replayed"]);
    const results = await Promise.all(
      ["b", "c"].map((hash) =>
        consumeMcpOAuthAuthorizationRequest(client!.db, {
          requestHash,
          subjectId: "user:person",
          codeHash: hash.repeat(64),
          codeExpiresAt: new Date(Date.now() + 60_000),
          hostAdmission: input,
          hostBrowserAuthUserId: "person",
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("conflict");
    expect(
      (await admin!`select count(*)::int as count from mcp_oauth_authorization_codes`)[0]!.count,
    ).toBe(1);
  });
  test("attribution recording failure rolls admission back atomically", async () => {
    if (!client) return;
    await seed();
    const proposal = await freeze();
    const input = admissionFor(proposal!);
    await admin!.unsafe(
      `alter table organization_host_command_attributions add constraint injected_recording_failure check (acting_external_source <> 'test:host')`,
    );
    try {
      await expect(admitMcpOAuthHostProposal(client.db, input)).rejects.toThrow();
    } finally {
      await admin!.unsafe(
        `alter table organization_host_command_attributions drop constraint injected_recording_failure`,
      );
    }
    expect(
      (await readMcpOAuthHostProposal(client.db, { organizationId, requestHash }))!.admitted,
    ).toBe(false);
    expect(
      (await admin!`select count(*)::int as count from organization_host_command_attributions`)[0]!
        .count,
    ).toBe(0);
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("admitted");
    expect(
      await admitMcpOAuthHostProposal(client.db, {
        ...input,
        attribution: {
          ...input.attribution,
          actingExternalUser: { source: "test:host", externalId: "other" },
        },
      }),
    ).toBe("conflict");
  });
  test("expired or cancelled requests cannot be admitted or consumed", async () => {
    if (!client) return;
    await seed();
    const proposal = await freeze();
    const input = admissionFor(proposal!);
    await admin!`update mcp_oauth_authorization_requests set expires_at = clock_timestamp() - interval '1 second'`;
    expect(await admitMcpOAuthHostProposal(client.db, input)).toBe("conflict");
    expect(await freeze()).toBeNull();
    await seed();
    const active = await freeze();
    const admission = admissionFor(active!);
    await admin!`delete from mcp_oauth_authorization_requests`;
    expect(await admitMcpOAuthHostProposal(client.db, admission)).toBe("conflict");
    expect(await readMcpOAuthHostProposal(client.db, { organizationId, requestHash })).toBeNull();
  });
});

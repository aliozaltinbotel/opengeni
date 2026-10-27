import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withAccountRls } from "./database";

export type OrganizationHostCommandAttribution = {
  organizationId: string;
  operationId: string;
  mutation: string;
  serviceSubjectId: string;
  serviceInitiatorSubjectId: string;
  actingExternalUser: { source: string; externalId: string };
};

export type OrganizationHostCommandAttributionResult = "recorded" | "replayed" | "conflict";

type AttributionRow = {
  mutation: string;
  service_subject_id: string;
  service_initiator_subject_id: string;
  acting_external_source: string;
  acting_external_id: string;
};

/**
 * Names who asked for a host command before the operation runs. The same
 * operation id replays only for the same command, service and acting user;
 * anything else is a conflict and the operation must not run.
 */
export async function recordOrganizationHostCommandAttribution(
  db: Database,
  input: OrganizationHostCommandAttribution,
): Promise<OrganizationHostCommandAttributionResult> {
  return await withAccountRls(db, input.organizationId, async (scopedDb) => {
    const inserted = await rawRows<{ operation_id: string }>(
      scopedDb,
      sql`insert into organization_host_command_attributions (
          account_id, operation_id, mutation, service_subject_id,
          service_initiator_subject_id, acting_external_source, acting_external_id
        ) values (
          ${input.organizationId}::uuid, ${input.operationId}::uuid, ${input.mutation},
          ${input.serviceSubjectId}, ${input.serviceInitiatorSubjectId},
          ${input.actingExternalUser.source}, ${input.actingExternalUser.externalId}
        )
        on conflict (account_id, operation_id) do nothing
        returning operation_id`,
    );
    if (inserted.length === 1) return "recorded";
    const [existing] = await rawRows<AttributionRow>(
      scopedDb,
      sql`select mutation, service_subject_id, service_initiator_subject_id,
          acting_external_source, acting_external_id
        from organization_host_command_attributions
        where account_id = ${input.organizationId}::uuid
          and operation_id = ${input.operationId}::uuid`,
    );
    return existing && attributionMatches(existing, input) ? "replayed" : "conflict";
  });
}

function attributionMatches(
  row: AttributionRow,
  input: OrganizationHostCommandAttribution,
): boolean {
  return (
    row.mutation === input.mutation &&
    row.service_subject_id === input.serviceSubjectId &&
    row.service_initiator_subject_id === input.serviceInitiatorSubjectId &&
    row.acting_external_source === input.actingExternalUser.source &&
    row.acting_external_id === input.actingExternalUser.externalId
  );
}

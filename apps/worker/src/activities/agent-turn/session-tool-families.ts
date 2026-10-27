import {
  sessionToolFamilyGate,
  type SessionToolFamilyGate,
} from "@opengeni/contracts/organization-session-policy";
import type { Settings } from "@opengeni/config";
import { getOrganizationSessionPolicy, type Database } from "@opengeni/db";

/*
 * The organization's session policy at the turn boundary. The worker has no
 * governance port: it reads what the API stored (the host's policy, or the
 * governed default stored when the organization was first seen governed).
 * Nothing stored means nothing is removed.
 */

/** Read once per turn; a failed read fails the turn (closed). */
export async function readTurnSessionToolFamilyGate(
  db: Database,
  organizationId: string,
): Promise<SessionToolFamilyGate> {
  return sessionToolFamilyGate((await getOrganizationSessionPolicy(db, organizationId))?.policy);
}

/** Every tool whose family the policy denies is removed; order is kept. */
export function withoutDeniedFamilyTools<T>(
  tools: readonly T[],
  nameOf: (tool: T) => string,
  gate: SessionToolFamilyGate,
): T[] {
  return gate.deniedFamilies.size === 0
    ? [...tools]
    : tools.filter((tool) => gate.allowsTool(nameOf(tool)));
}

/**
 * How this attempt delivers its Codemode bearer. Codemode runs from the
 * sandbox shell, so a policy that denies either family mints none.
 */
export function codemodeDeliveryForTurn(
  activeSandboxBackend: Settings["sandboxBackend"] | undefined,
  gate: SessionToolFamilyGate,
): "managed_file" | "transient_exec" | "none" {
  if (gate.denies("codemode") || gate.denies("shell")) return "none";
  return activeSandboxBackend === "selfhosted" ? "transient_exec" : "managed_file";
}

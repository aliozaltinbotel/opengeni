import {
  storeGovernedOrganizationSessionPolicyDefaults,
  type GovernedSessionPolicyDefaultsResult,
  type OrganizationGovernanceDeps,
} from "@opengeni/core";
import type { Observability } from "@opengeni/observability";

type BackfillObservability = Pick<Observability, "incrementCounter" | "info" | "warn" | "error">;

const OUTCOME_METRIC = {
  name: "opengeni_governed_session_policy_defaults_total",
  help: "Governed organizations visited by the API's startup session-policy pass, by outcome.",
} as const;

/**
 * The API's startup pass over organizations a host governed before migration
 * 1018 (storeGovernedOrganizationSessionPolicyDefaults), started in the
 * background so serving never waits for it: the caller does not await the
 * returned promise, which settles when the pass ends and never rejects. Each
 * governed organization counts once under its outcome (stored, present,
 * failed); each failure is also logged with its organization, and one summary
 * line closes the pass. Undefined when the pass itself could not run (its
 * organization listing failed).
 */
export function startGovernedSessionPolicyBackfill(
  deps: OrganizationGovernanceDeps,
  observability: BackfillObservability,
): Promise<GovernedSessionPolicyDefaultsResult | undefined> {
  const startedAt = Date.now();
  return storeGovernedOrganizationSessionPolicyDefaults(deps, {
    onOrganization: ({ organizationId, outcome, error }) =>
      observe(() => {
        observability.incrementCounter({ ...OUTCOME_METRIC, labels: { outcome } });
        if (outcome === "failed")
          observability.warn("governed session policy default could not be stored", {
            organizationId,
            errorClass: errorClassOf(error),
            errorCode: "governed_session_policy_default_failed",
            origin: "api",
          });
      }),
  }).then(
    (result) => {
      observe(() =>
        observability.info("governed session policy defaults stored", {
          ...result,
          durationMs: Date.now() - startedAt,
        }),
      );
      return result;
    },
    (error: unknown) => {
      observe(() =>
        observability.error("governed session policy defaults could not be stored", {
          errorClass: errorClassOf(error),
          errorCode: "governed_session_policy_backfill_failed",
          origin: "api",
        }),
      );
      return undefined;
    },
  );
}

function errorClassOf(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Observer failures never reach the pass or its promise. */
function observe(report: () => void): void {
  try {
    report();
  } catch {
    // The metrics or logging sink is unhealthy; the pass stays authoritative.
  }
}

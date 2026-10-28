import {
  storeGovernedOrganizationSessionPolicyDefaults,
  type GovernedSessionPolicyDefaultsResult,
  type OrganizationGovernanceDeps,
} from "@opengeni/core";
import type { Observability } from "@opengeni/observability";

type BackfillObservability = Pick<
  Observability,
  "incrementCounter" | "info" | "warn" | "error" | "recordFailureDiagnostic"
>;

const DEFAULT_FAILED = "governed_session_policy_default_failed";
const PASS_FAILED = "governed_session_policy_backfill_failed";

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
 * failed); each failure also records a protected failure diagnostic naming
 * its organization and logs its id publicly, and one summary line closes the
 * pass. Undefined when the pass itself could not run (its
 * organization listing failed).
 */
export function startGovernedSessionPolicyBackfill(
  deps: OrganizationGovernanceDeps,
  observability: BackfillObservability,
): Promise<GovernedSessionPolicyDefaultsResult | undefined> {
  const startedAt = Date.now();
  return storeGovernedOrganizationSessionPolicyDefaults(deps, {
    onOrganization: ({ organizationId, outcome, error }) => {
      observe(() => observability.incrementCounter({ ...OUTCOME_METRIC, labels: { outcome } }));
      if (outcome === "failed")
        warnWithDiagnostic(
          observability,
          "warn",
          "governed session policy default could not be stored",
          { code: DEFAULT_FAILED, error, organizationId },
        );
    },
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
      warnWithDiagnostic(
        observability,
        "error",
        "governed session policy defaults could not be stored",
        { code: PASS_FAILED, error },
      );
      return undefined;
    },
  );
}

/**
 * The failure's facts, the organization id included, go to the protected
 * failure diagnostic (exported only to OPENGENI_OBSERVABILITY_DIAGNOSTICS_ENDPOINT);
 * the public log line carries its error code and the diagnostic's id as
 * `correlationId`, never an identifier.
 */
function warnWithDiagnostic(
  observability: BackfillObservability,
  level: "warn" | "error",
  message: string,
  failure: {
    code: typeof DEFAULT_FAILED | typeof PASS_FAILED;
    error: unknown;
    organizationId?: string;
  },
): void {
  let correlationId: string | undefined;
  observe(() => {
    correlationId = observability.recordFailureDiagnostic({
      code: failure.code,
      stage: "governed_session_policy.startup_pass",
      error: failure.error,
      ...(failure.organizationId ? { organizationId: failure.organizationId } : {}),
    });
  });
  observe(() =>
    observability[level](message, {
      errorClass: "OperationError",
      errorCode: failure.code,
      origin: "api",
      ...(correlationId ? { correlationId } : {}),
    }),
  );
}

/** Observer failures never reach the pass or its promise. */
function observe(report: () => void): void {
  try {
    report();
  } catch {
    // The metrics or logging sink is unhealthy; the pass stays authoritative.
  }
}

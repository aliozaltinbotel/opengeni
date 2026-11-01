import type { Settings } from "@opengeni/config";
import type {
  Document,
  DocumentAuthorityKind,
  EntitlementsPort,
  GitHubAppApiPort,
  ScheduledTask,
  ScheduledTaskTriggerType,
  SessionAuthorizationPort,
  TurnInitiator,
} from "@opengeni/contracts";
import type { Database, SessionWorkflowWakeDeliveryResult } from "@opengeni/db";
import type { VaultConnectionCredentialsPort } from "@opengeni/vaults";
import type { OnePasswordVaultProviderFactory } from "./domain/vaults/provider-registry";
import type { ExternalVaultProviderFactories } from "./domain/vaults/external-provider-connections";
import type { DocumentServices } from "@opengeni/documents";
import type { EventBus } from "@opengeni/events";
import type { Observability } from "@opengeni/observability";
import type { UserPresenceRecorder } from "./user-presence";
import type { createObjectStorage } from "@opengeni/storage";
import type { ManagedAuth } from "./managed-auth-type";
import type { ManagedAuthSessionAdapter } from "./managed-auth-session-sets";
import type { ApiSandboxClient, ResumeBoxByIdInput, ResumedSandboxSession } from "./sandbox-types";
import type { TranscriptionSegmenter, TranscriptionService } from "./transcription";
import type { SpeechToTextDeployment } from "./transcription-service/deployment";
import type { ModelCallService } from "./model-call";
import type { EditableArtifactApplicationPort } from "./editable-artifact-live";
import type { ResolvedCatalogSettings } from "./model-catalog";
import type {
  EditableArtifactAgentApplication,
  EditableArtifactDurableExportService,
  EditableArtifactOfficeImportPort,
} from "./editable-artifacts";
import type { ExternalActorContinuation } from "@opengeni/contracts/external-identities";
import type {
  HostWebhookDeliveryRequest,
  OrganizationGovernancePort,
  McpOAuthHostConsentPort,
} from "@opengeni/contracts/organization-governance";
import type { LocalMcpServerRegistration } from "@opengeni/runtime";
import type { AccessGrant, KnowledgeEntryListRequest, KnowledgeEntryListResponse, KnowledgeSavePreparationRequest, KnowledgeSavePreparationResponse } from "@opengeni/contracts";
import type { KnowledgeContext } from "@opengeni/db";
import type { NativeAccessContinuation } from "./access";

/** Private authenticated execution input. Never a public query-schema field or
 * a usage export: it carries the installed host's exact current-guard proof. */
export type KnowledgeQueryWorkflowRequest = {
  context: KnowledgeContext;
  request: KnowledgeEntryListRequest;
  operationId: string;
  grant: AccessGrant;
  externalContinuation: ExternalActorContinuation | null;
  nativeContinuation?: NativeAccessContinuation | null;
};
export type KnowledgePreparationWorkflowRequest = Omit<KnowledgeQueryWorkflowRequest, "request"> & {
  request: KnowledgeSavePreparationRequest;
};

export type SessionWorkflowClient = {
  queryKnowledge?: (input: KnowledgeQueryWorkflowRequest) => Promise<KnowledgeEntryListResponse>;
  prepareKnowledge?: (input: KnowledgePreparationWorkflowRequest) => Promise<KnowledgeSavePreparationResponse>;
  startRealtimeUsageObservation?: (input: { accountId: string; workspaceId: string; sessionId: string; connectionId: string }) => Promise<void>;
  /**
   * Start one durable host webhook delivery (`settings.hostWebhooks`), before
   * the change it reports is written; the worker sends it once it sees the
   * change committed. Idempotent on `deliveryId`. The implementation bounds
   * the start with its own deadline (the API's Temporal client: 3 seconds):
   * the change waits for it, and a start that fails or times out is only
   * reported.
   */
  startHostWebhookDelivery?: (input: HostWebhookDeliveryRequest) => Promise<void>;
  triggerAutomationRun?: (input: {
    accountId: string;
    workspaceId: string;
    runId: string;
  }) => Promise<void>;
  signalUserMessage: (input: {
    sessionId: string;
    eventId: string;
    workflowId: string;
  }) => Promise<void>;
  wakeSessionWorkflow: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    wakeRevision: number;
    interruptionRequested?: boolean;
    /** Called after transport acceptance, before the fallible durable ACK. */
    onSignalAccepted?: () => void;
  }) => Promise<SessionWorkflowWakeDeliveryResult | void>;
  /** Trigger one bounded drain of already-committed workflow-wake revisions. */
  requestSessionWorkflowWakeDispatch: () => Promise<void>;
  // Dedicated, revision-carrying nudge for a durable Codex capacity waiter.
  // Optional for embedded/back-compat clients: callers may fall back to the
  // generic queueChanged wake because Postgres wakeRevision is authoritative.
  signalCodexCapacity?: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    workflowId: string;
    wakeRevision: number;
    workflowWakeRevision: number;
  }) => Promise<void>;
  signalApprovalDecision: (input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    eventId: string;
    workflowId: string;
    workflowWakeRevision: number;
  }) => Promise<void>;
  syncScheduledTask: (input: {
    task: Pick<ScheduledTask, "id" | "workspaceId" | "temporalScheduleId">;
    /**
     * Compensate under the same per-schedule writer lock. Return the error to
     * throw only after this transaction commits; lock/commit failures bypass
     * that receipt. A failing compensation must roll back its own savepoint.
     */
    onFailure?: (tx: Database, error: unknown) => Promise<Error>;
  }) => Promise<void>;
  deleteScheduledTaskSchedule: (input: { temporalScheduleId: string }) => Promise<void>;
  triggerScheduledTask: (input: {
    task: ScheduledTask;
    agentRunUsageIdempotencyKey: string;
    triggerWorkflowId: string;
    initiator: TurnInitiator;
    /** Server-frozen caller ceiling for this run, independent of task ownership. */
    credentialRestriction?: "developer_setup";
    triggerType?: Extract<
      ScheduledTaskTriggerType,
      "manual" | "initial" | "provider_event" | "retry" | "repair"
    >;
  }) => Promise<void>;
  startRigVerification: (input: {
    workspaceId: string;
    changeId?: string;
    versionId?: string;
    workflowId?: string;
  }) => Promise<void>;
  /**
   * Durably deletes objects a request staged in storage once `deleteAfter`
   * passes, whether or not the request ever finishes. Repeating the same keys
   * is a no-op. Optional for embedded clients; callers without it must clean
   * up within the request.
   */
  scheduleTransientObjectDeletion?: (input: {
    workspaceId: string;
    objectKeys: string[];
    deleteAfter: Date;
  }) => Promise<void>;
  /**
   * Start a recording's transcript or deletion workflow. Starting one that is
   * already running does nothing. Optional for embedded clients; the worker's
   * recovery sweep starts any it misses.
   */
  startRecordingWorkflow?: (input: {
    kind: "transcript" | "deletion";
    accountId: string;
    workspaceId: string;
    recordingId: string;
    versionId: string | null;
    ownerSubjectId: string;
  }) => Promise<void>;
  /**
   * Record an agent's browser recording whose frame bundle is uploaded and
   * make its video. Starting it again for the same recording while it runs,
   * or after it finished, does nothing.
   */
  startBrowserRecordingVideo?: (input: {
    accountId: string;
    workspaceId: string;
    recordingId: string;
    ownerSubjectId: string;
    visibility: "private" | "workspace";
    startedAt: string;
    durationMilliseconds: number;
    bundle: { byteLength: number; sha256: string };
  }) => Promise<void>;
  check?: () => Promise<void>;
};

export type DocumentIndexClient = {
  indexDocument: (input: {
    accountId: string;
    workspaceId: string;
    documentId: string;
    authorityKind: DocumentAuthorityKind;
    authorityWorkspaceId: string | null;
    authoritySubjectId: string | null;
  }) => Promise<Document | void>;
};

export type ManagedEmailMessage = {
  kind:
    | "email_verification"
    | "password_reset"
    | "organization_user_setup"
    | "sign_in_method_changed"
    | "site_abuse_notice";
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
};

export type ManagedEmailDeliveryResult =
  | { status: "sent"; providerMessageId: string | null }
  | { status: "failed"; errorClass: string }
  | { status: "outcome_unknown"; errorClass: string };

/** Provider-neutral, injectable boundary for every managed-auth email. */
export type ManagedEmailTransport = {
  /** Effective provider sender; frozen into any idempotent payload digest. */
  readonly sender: string;
  /**
   * Stable non-secret provider/account/policy namespace plus the provider's
   * guaranteed key-retention window. Both are durably fenced before I/O.
   */
  readonly idempotency: {
    readonly scope: string;
    readonly retentionSeconds: number;
  };
  send(message: ManagedEmailMessage): Promise<ManagedEmailDeliveryResult>;
};

export type AppDependencies = {
  settings: Settings;
  /**
   * Original deployment settings when `settings` is already overlaid with a
   * deployment/workspace catalog snapshot. Model-bearing request adapters set
   * this marker so core admission never feeds a synthetic reviewed provider
   * back through deployment validation.
   */
  catalogSourceSettings?: Settings;
  db: Database;
  /** Read-only host funding admission; unset uses the standalone billing ledger. */
  entitlements?: EntitlementsPort | null;
  /**
   * Host-composed editable artifact engine. Standalone startup binds the same
   * native kernel/DB/object-store implementation; embedded hosts may inject an
   * equivalent deployment-scoped composition.
   */
  editableArtifacts?: EditableArtifactApplicationPort;
  /** Durable immutable version/materialization API paired with editableArtifacts. */
  editableArtifactExports?: EditableArtifactDurableExportService;
  /** Canonical agent-facing artifact use cases shared by MCP and Codemode. */
  editableArtifactAgent?: EditableArtifactAgentApplication;
  /** Trusted Office-file to canonical sequence-zero import boundary. */
  editableArtifactOfficeImports?: EditableArtifactOfficeImportPort;
  bus: EventBus;
  workflowClient: SessionWorkflowClient;
  /**
   * Injectable structural seam for replayable post-commit fanout and wake work.
   * The historical name is retained for host compatibility; every interactive
   * session command now uses this boundary, not only prompt submission.
   */
  schedulePromptPostCommit?: (task: () => Promise<void>) => void;
  /** Optional provider override for deterministic API/object-storage tests. */
  objectStorage?: ObjectStorageDependency;
  documentIndexer?: DocumentIndexClient;
  documentServices?: DocumentServices;
  observability?: Observability;
  /**
   * Throttled server-side presence for canonical managed browser sessions
   * (`createUserPresenceRecorder`). Analytics only; never an authorization input.
   */
  userPresence?: UserPresenceRecorder | null;
  readinessChecks?: Partial<Record<"db" | "nats" | "temporal", () => Promise<void> | void>>;
  githubStateSecret?: string;
  /**
   * Optional host-provided GitHub App API seam. Embedded hosts can authorize
   * users, inspect installations, and list repositories with their own GitHub
   * App credentials; standalone deployments fall back to @opengeni/github.
   */
  githubAppApi?: GitHubAppApiPort;
  /** Optional provider seam for the separately registered Opengeni Lens App. */
  prReviewGithubAppApi?: GitHubAppApiPort;
  /**
   * Optional host-owned connection credential seam. API-side consumers use
   * the MCP leg for Codemode/Code Mode; worker consumers bind the same port
   * for model MCP, Git, and run credentials. `vaultProvider` is the host's
   * password manager, linked as vaults with `source: "host"` (OP-6).
   */
  connectionCredentials?: VaultConnectionCredentialsPort | null;
  /**
   * Builds 1Password providers for linked vaults. apps/api and apps/worker
   * bind it to a dynamic `import("@opengeni/vaults-onepassword")`; unset means
   * 1Password vaults report `provider_unavailable`.
   */
  onePasswordVaultProvider?: OnePasswordVaultProviderFactory | null;
  /** Lazy native/remote vault adapters; null disables the first-wave integrations. */
  externalVaultProviders?: ExternalVaultProviderFactories | null;
  /**
   * Optional embedding-host session ACL. Unset preserves standalone workspace
   * authorization; once bound, every session-addressed surface fails closed on
   * an unavailable or invalid host decision.
   */
  sessionAuthorization?: SessionAuthorizationPort | null;
  /**
   * Optional embedding-host membership governance. Unset (or null) preserves
   * standalone administration; once bound, a governed organization refuses each
   * membership, role and credential mutation the host does not allow, and the
   * host's own commands are served under `/v1/host/organizations/*`.
   */
  organizationGovernance?: OrganizationGovernancePort | null;
  /** Optional human-authenticated handoff; durable HOST admission remains required. */
  mcpOAuthHostConsent?: McpOAuthHostConsentPort | null;
  /**
   * Optional embedding-host tool servers for the workspace tool gateway (the
   * workspace MCP server, HTTP `/tools/*`, Sites and current-human calls).
   * Called once per gateway preparation with the caller's grant; it returns
   * fresh in-process MCP servers, which the gateway closes after the request.
   * It must honour `signal` (the caller's request lifetime). A throw or
   * rejection fails the whole catalog closed for that request. A returned
   * server whose connect or `tools/list` fails is only left out: its tools are
   * absent from the catalog and the preparation records it in
   * `unavailableMcpServers`, as for a failed connector. A call to a tool of a
   * server left out is refused like any tool not in the catalog, and a listed
   * tool's failing call still fails loud.
   *
   * A registration is used only when its id names a deployment-static
   * `settings.mcpServers` entry configured for the request, replacing that
   * entry's remote transport; other ids are ignored. Workspace-installed
   * servers (capabilities, API integrations) never adopt a host server: a
   * static host entry wins over a workspace server of the same id. The entry's
   * settings (allowed tools, approval policy) and the connector tool policy
   * apply exactly as for any MCP server. An id equal to a first-party server
   * (`opengeni`, `files`, `docs`), `codex_apps`, a workspace-installed server
   * without a static entry, or another host registration is refused with
   * `HOST_TOOL_SERVER_ID_CONFLICT`. Return the same servers for every grant and
   * scope by grant inside each server's tools: a configured entry the port
   * omits keeps its remote transport, like any other configured server.
   *
   * A used registration's `extensionMethods` are served on the workspace MCP
   * server only and advertised under `capabilities.experimental[<id>]`. Each
   * call runs the same reauthorize step as `tools/list`, then the handler with
   * the request's grant. A malformed name, a core MCP method, a name in a core
   * method's namespace, or a method two registrations declare is refused with
   * `HOST_MCP_METHOD_CONFLICT`. MCP OAuth consent scopes extension methods per
   * host server, not per method: a connection consented to any of a host
   * server's tools can call all of that server's extension methods.
   */
  workspaceToolServers?: (input: {
    grant: AccessGrant;
    signal?: AbortSignal;
  }) => Promise<readonly LocalMcpServerRegistration[]>;
  managedAuth?: ManagedAuth | null;
  /** Provider-neutral browser login-slot adapter; required by dual/broker managed auth. */
  managedAuthSessionAdapter?: ManagedAuthSessionAdapter | null;
  /** Injectable managed-email transport; standalone API defaults to Resend or local capture. */
  managedEmailTransport?: ManagedEmailTransport;
  /** Injectable Codex HTTP transport for deterministic API/provider tests. */
  codexFetch?: typeof fetch;
  /** Injectable transport for customer OpenAI/Azure connection checks. */
  directModelFetch?: typeof fetch;
  /** Injectable GitHub transport for deterministic personal-OAuth tests. */
  githubPersonalFetch?: typeof fetch;
  /** Injectable credential-free GitHub transport for public repository verification tests. */
  githubAnonymousFetch?: typeof fetch;
  /** Injectable xAI OAuth/subscription transport for deterministic API/provider tests. */
  xaiFetch?: typeof fetch;
  /** Injectable Claude usage transport on the shared core, for deterministic API tests. */
  claudeFetch?: typeof fetch;
  /** Injectable Slack Web API transport for deterministic bot-connection tests. */
  slackFetch?: typeof fetch;
  /** Injectable Google OAuth/Drive transport for deterministic connector tests. */
  googleDriveFetch?: typeof fetch;
  /** Injectable transport for reading event sources (MCP servers and Gmail), for tests. */
  eventSourceFetch?: typeof fetch;
  /** Injectable Fiken API transport for deterministic connector tests. */
  fikenFetch?: typeof fetch;
  /** Injectable Integration Definition OAuth/API transport for deterministic tests. */
  apiIntegrationOAuthFetch?: typeof fetch;
  /** Injectable specification/introspection transport, still network-policy checked. */
  apiIntegrationSourceFetch?: typeof fetch;
  /** Injectable bounded MCP initialization/tools-list probe for Connect tests. */
  mcpCapabilityProbe?: import("./domain/capabilities").McpCapabilityProbe;
  atlassianFetch?: typeof fetch;
  /** Injectable MCP OAuth setup deadline for deterministic stalled-provider tests. */
  oauthStartDeadlineMs?: number;
  /** Injectable MCP OAuth callback deadline for deterministic stalled-provider tests. */
  oauthCallbackDeadlineMs?: number;
  /**
   * The deployment's speech-to-text providers, shared by voice input and
   * recordings; built from settings when omitted.
   */
  speechToText?: SpeechToTextDeployment;
  /** Optional host-owned voice-input transcription service. */
  transcription?: TranscriptionService | null;
  /** Optional host-owned long-form audio normalization/segmentation service. */
  transcriptionSegmenter?: TranscriptionSegmenter | null;
  /** Stateless single model calls (chat completions); built from settings when omitted. */
  modelCalls?: ModelCallService | null;
  // The API process's OWN agent-loop-free sandbox client (constructed from
  // settings via @opengeni/runtime/sandbox). Undefined when sandboxBackend=none.
  // This is the foundation of the API-direct control plane: the API resumes
  // boxes by id in-process, no Temporal/worker for non-turn ops. Optional on
  // construction (createApp builds it from settings when absent) so existing
  // tests that pass a minimal deps bag keep working.
  sandboxClient?: ApiSandboxClient;
  /**
   * Resume a box by id from a serialized resume_state envelope (the lease's
   * `resume_state` + `resume_backend_id` from P1.1) and return a live session
   * for a single in-process op. resume → use → drop; the lease owns lifecycle,
   * the returned handle does NOT own the box. Throws SandboxResumeError on a
   * backend mismatch or a resume failure.
   */
  resumeBoxById?: (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession>;
};

export type ObjectStorageDependency = ReturnType<typeof createObjectStorage>;

export type ApiRouteDeps = AppDependencies & {
  resolveCatalogSettings: () => Promise<ResolvedCatalogSettings>;
  managedEmailTransport: ManagedEmailTransport;
  objectStorage: ObjectStorageDependency;
  githubStateSecret: string;
  documentIndexer: DocumentIndexClient;
  getDocumentServices: () => DocumentServices;
  // Resolved by createApp from settings: routes always get a concrete
  // resumeBoxById (it throws SandboxResumeError when sandboxBackend=none).
  resumeBoxById: (input: ResumeBoxByIdInput) => Promise<ResumedSandboxSession>;
};

/**
 * The exact dependency slice used by `acceptSessionUserMessage`.
 *
 * Keeping this narrower than `ApiRouteDeps` lets control-plane callers reuse
 * the canonical admission path without constructing unrelated HTTP, document,
 * or sandbox services. The public API still passes its `ApiRouteDeps` superset.
 */
export type AcceptSessionUserMessageDependencies = Pick<
  AppDependencies,
  | "settings"
  | "catalogSourceSettings"
  | "db"
  | "bus"
  | "sessionAuthorization"
  | "schedulePromptPostCommit"
  | "observability"
  | "organizationGovernance"
> & {
  workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
  objectStorage: ObjectStorageDependency;
};

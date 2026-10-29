import * as primitives from "./primitives";
import { defineSchema } from "./define-schema";
import { z } from "zod";
import { Permission } from "./permissions";

export const ATTEMPT_TOOL_CATALOG_VERSION = 1 as const;
export const TOOL_GATEWAY_CATALOG_VERSION = 1 as const;
export const ATTEMPT_TOOL_CATALOG_MAX_ENTRIES = 4_096;
export const ATTEMPT_TOOL_CATALOG_MAX_BYTES = 16 * 1024 * 1024;
export const ATTEMPT_TOOL_CATALOG_MAX_PATH_SEGMENTS = 8;
export const ATTEMPT_TOOL_CATALOG_MAX_CONTENT_BLOCKS = 1_024;
export const CODEMODE_OPERATION_VERSION = 1 as const;
export const CODEMODE_ARGUMENTS_MAX_BYTES = 4 * 1024 * 1024;
export const CODEMODE_RESULT_MAX_BYTES = 16 * 1024 * 1024;
export const CODEMODE_DISPATCH_TIMEOUT_MS = 5_000;
export const CODEMODE_CLAIM_LEASE_MS = 30_000;
export const CODEMODE_CLAIM_HEARTBEAT_MS = 10_000;
export const CODEMODE_MAX_CONCURRENT_CALLS_PER_ATTEMPT = 16;

const sha256 = /* @__PURE__ */ defineSchema(() => primitives.string.regex(/^[0-9a-f]{64}$/u));
const serverIdentifier = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/u),
);
const toolIdentifier = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\u0000-\u001f\u007f]+$/u),
);
const namespaceSegment = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/u)
    .refine((value) => !["__proto__", "prototype", "constructor"].includes(value), {
      message: "unsafe Codemode namespace segment",
    }),
);
const jsonObject = /* @__PURE__ */ defineSchema(() => z.record(z.string().max(512), z.json()));

/** Opaque authority identity. Display/wire names must never be parsed as authority. */
export const AttemptToolIdentity = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      serverId: serverIdentifier,
      toolName: toolIdentifier,
    })
    .strict(),
);
export type AttemptToolIdentity = z.infer<typeof AttemptToolIdentity>;

/** Protocol-neutral tool identity shared by MCP, HTTP/SDK, agents, and Codemode. */
export const ToolGatewayIdentity = AttemptToolIdentity;
export type ToolGatewayIdentity = AttemptToolIdentity;

export const AttemptToolCatalogIcon = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      src: z.string().min(1).max(8_192),
      mimeType: z.string().min(1).max(128).optional(),
      sizes: z.array(z.string().min(1).max(64)).max(16).optional(),
      theme: z.enum(["light", "dark"]).optional(),
    })
    .strict(),
);
export type AttemptToolCatalogIcon = z.infer<typeof AttemptToolCatalogIcon>;

/** MCP annotations retained without inventing stronger effect guarantees. */
export const AttemptToolAnnotations = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      title: z.string().max(512).optional(),
      readOnlyHint: primitives.optionalBoolean,
      destructiveHint: primitives.optionalBoolean,
      idempotentHint: primitives.optionalBoolean,
      openWorldHint: primitives.optionalBoolean,
    })
    .loose(),
);
export type AttemptToolAnnotations = z.infer<typeof AttemptToolAnnotations>;

/** JSON Schema is preserved as received. Runtime byte/node guards remain authoritative. */
export const AttemptToolJsonSchema = jsonObject;
export type AttemptToolJsonSchema = z.infer<typeof AttemptToolJsonSchema>;

/** Presentation only; never parsed as execution or account authority. */
export const ToolDisplayMetadata = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      toolName: toolIdentifier,
      title: z.string().min(1).max(512).optional(),
      /** Account to name beside the tool. Set only when the connector has more than one. */
      accountLabel: z.string().min(1).max(1024).optional(),
      /** The connector the tool belongs to, e.g. "Linear". */
      connector: z.string().min(1).max(512).optional(),
      /** The connector's provider, so a host can draw its logo. */
      providerDomain: z.string().min(1).max(253).optional(),
    })
    .strict(),
);
export type ToolDisplayMetadata = z.infer<typeof ToolDisplayMetadata>;

/**
 * How one connector account route is named. The model always gets the full
 * account in tool descriptions; people see the connector, and the account only
 * when there is more than one to tell apart.
 */
export type McpAccountRouteLabel = {
  /** Model-facing account description. */
  model: string;
  connector: string;
  providerDomain: string;
  /** Present only when the connector has several accounts in the turn. */
  account?: string | undefined;
  /**
   * The kind of need the connector serves, its catalog category
   * ("communication", "files"), when one is known. Never model-facing.
   */
  kind?: string | undefined;
};

/** The short account line for approvals: "Linear", or "Linear · alice@example.com". */
export function mcpAccountRouteReviewLabel(label: McpAccountRouteLabel): string {
  return label.account ? `${label.connector} · ${label.account}` : label.connector;
}

/**
 * `error.data.code` of the workspace MCP's `tools/call` refusal (JSON-RPC
 * `-32602`, as MCP answers an unknown tool) for a tool name this connection
 * cannot call: outside the tools an MCP OAuth connection was consented to
 * (`TOOL_NOT_CONSENTED`), not in the caller's catalog at all
 * (`TOOL_NOT_FOUND`), or listed only for a person to approve and never
 * callable over MCP (`TOOL_APPROVAL_REQUIRED`), or app-only and never callable
 * by a model (`TOOL_NOT_MODEL_VISIBLE`).
 */
export const WORKSPACE_MCP_TOOL_REFUSAL_CODES = Object.freeze({
  notConsented: "TOOL_NOT_CONSENTED",
  notFound: "TOOL_NOT_FOUND",
  approvalRequired: "TOOL_APPROVAL_REQUIRED",
  notModelVisible: "TOOL_NOT_MODEL_VISIBLE",
} as const);
export type WorkspaceMcpToolRefusalCode =
  (typeof WORKSPACE_MCP_TOOL_REFUSAL_CODES)[keyof typeof WORKSPACE_MCP_TOOL_REFUSAL_CODES];

/** MIME type of an MCP Apps view resource (SEP-1865). */
export const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app" as const;

/** An MCP Apps view: a `ui://` HTML resource that the tool's own server serves. */
export const McpAppResourceUri = /* @__PURE__ */ defineSchema(() =>
  z
    .string()
    .max(2_048)
    .regex(/^ui:\/\/[a-z0-9.-]+\/[A-Za-z0-9._/-]+\.html$/u),
);

/** Who may call an MCP Apps tool: the model, the view (`app`), or both (the default). */
export const McpAppToolVisibility = /* @__PURE__ */ defineSchema(() => z.enum(["model", "app"]));
export type McpAppToolVisibility = z.infer<typeof McpAppToolVisibility>;

/** A tool's MCP Apps `visibility`: one or both callers, each at most once. */
const mcpAppToolVisibilityList = () =>
  z
    .array(McpAppToolVisibility)
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length, "duplicate visibility");

/**
 * A tool definition's `_meta.ui` (MCP Apps `McpUiToolMeta`): the view that
 * renders its results and who may call it. `visibility` omitted means
 * `["model", "app"]`.
 */
export const McpAppToolUiMeta = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      resourceUri: McpAppResourceUri,
      visibility: mcpAppToolVisibilityList().optional(),
    })
    .strict(),
);
export type McpAppToolUiMeta = z.infer<typeof McpAppToolUiMeta>;

/**
 * A tool definition's `_meta.ui` that names no view (MCP Apps
 * `McpUiToolMeta.resourceUri` is optional): only who may call the tool.
 */
export const McpAppToolVisibilityUiMeta = /* @__PURE__ */ defineSchema(() =>
  z.object({ visibility: mcpAppToolVisibilityList() }).strict(),
);
export type McpAppToolVisibilityUiMeta = z.infer<typeof McpAppToolVisibilityUiMeta>;

/** Any well-formed tool `_meta.ui`: with a view, or a visibility alone. */
export type McpAppToolUi = McpAppToolUiMeta | McpAppToolVisibilityUiMeta;

/**
 * A view resource's `_meta.ui` (MCP Apps `UIResourceMeta`), on `resources/list`
 * and `resources/read` contents: the sandbox's content security policy, the
 * device permissions it asks for, its dedicated origin and border preference.
 */
export const McpAppResourceUiMeta = /* @__PURE__ */ defineSchema(() => {
  const domains = z.array(z.string().min(1).max(2_048)).max(64).optional();
  const permission = z.object({}).strict().optional();
  return z
    .object({
      csp: z
        .object({
          connectDomains: domains,
          resourceDomains: domains,
          frameDomains: domains,
          baseUriDomains: domains,
        })
        .strict()
        .optional(),
      permissions: z
        .object({
          camera: permission,
          microphone: permission,
          geolocation: permission,
          clipboardWrite: permission,
        })
        .strict()
        .optional(),
      domain: z.string().min(1).max(2_048).optional(),
      prefersBorder: z.boolean().optional(),
    })
    .strict();
});
export type McpAppResourceUiMeta = z.infer<typeof McpAppResourceUiMeta>;

function metaRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The MCP Apps `_meta.ui` of a listed tool, or undefined when it has none
 * that is well formed. The view comes from `ui.resourceUri`, else from the
 * deprecated flat `ui/resourceUri` key; a tool may also name no view and only
 * a `visibility`. A malformed `visibility` is dropped (the default then
 * applies); a malformed view is dropped independently of valid visibility.
 */
export function mcpAppToolUiMeta(meta: unknown): McpAppToolUi | undefined {
  const record = metaRecord(meta);
  const ui = metaRecord(record?.ui);
  const visibility = McpAppToolVisibilityUiMeta.shape.visibility.safeParse(ui?.visibility);
  const visible = visibility.success ? { visibility: visibility.data } : undefined;
  const rawResourceUri = ui?.resourceUri ?? record?.["ui/resourceUri"];
  if (rawResourceUri === undefined) return visible;
  const resourceUri = McpAppResourceUri.safeParse(rawResourceUri);
  return resourceUri.success ? { resourceUri: resourceUri.data, ...visible } : visible;
}

/** The well-formed MCP Apps `_meta.ui` of a view resource, or undefined. */
export function mcpAppResourceUiMeta(meta: unknown): McpAppResourceUiMeta | undefined {
  const parsed = McpAppResourceUiMeta.safeParse(metaRecord(meta)?.ui);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

/**
 * The tool-definition metadata a catalog keeps: only its MCP Apps `_meta.ui`
 * (a view, or a visibility alone).
 */
export const AttemptToolCatalogMeta = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      ui: z.union([McpAppToolUiMeta, McpAppToolVisibilityUiMeta]).optional(),
    })
    .strict(),
);
export type AttemptToolCatalogMeta = z.infer<typeof AttemptToolCatalogMeta>;

export const AttemptToolCatalogEntry = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      identity: AttemptToolIdentity,
      /** Exact model-wire projection for this generation, e.g. `slack__search`. */
      modelName: toolIdentifier,
      /** Safe generated Codemode namespace; convenience only, never authority. */
      codemodePath: z.array(namespaceSegment).min(2).max(ATTEMPT_TOOL_CATALOG_MAX_PATH_SEGMENTS),
      title: z.string().min(1).max(512).optional(),
      description: z.string().max(32_768).optional(),
      inputSchema: AttemptToolJsonSchema,
      outputSchema: AttemptToolJsonSchema.optional(),
      annotations: AttemptToolAnnotations.optional(),
      icons: z.array(AttemptToolCatalogIcon).max(16).optional(),
      /** Set only for an in-process host tool server's tool that publishes an MCP Apps `_meta.ui`. */
      meta: AttemptToolCatalogMeta.optional(),
      source: z.enum(["opengeni", "files", "docs", "mcp", "codex_apps", "interaction"]),
      approval: z.enum(["none", "human", "policy"]),
    })
    .strict(),
);
export type AttemptToolCatalogEntry = z.infer<typeof AttemptToolCatalogEntry>;

/** One canonical gateway entry. Adapter-specific names are projections, never authority. */
export const ToolGatewayCatalogEntry = AttemptToolCatalogEntry;
export type ToolGatewayCatalogEntry = AttemptToolCatalogEntry;

export const ToolGatewayCatalog = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(TOOL_GATEWAY_CATALOG_VERSION),
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      generation: primitives.positiveInteger,
      digest: sha256,
      createdAt: primitives.string.datetime({ offset: true }),
      entries: z.array(ToolGatewayCatalogEntry).max(ATTEMPT_TOOL_CATALOG_MAX_ENTRIES),
    })
    .strict()
    .superRefine((catalog, context) => {
      const identities = new Set<string>();
      const modelNames = new Set<string>();
      const toolPaths = new Set<string>();
      for (const [index, entry] of catalog.entries.entries()) {
        const identity = `${entry.identity.serverId}\u0000${entry.identity.toolName}`;
        const toolPath = entry.codemodePath.join(".");
        if (identities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "identity"],
            message: "duplicate tool identity",
          });
        }
        if (modelNames.has(entry.modelName)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "modelName"],
            message: "duplicate model tool name",
          });
        }
        if (toolPaths.has(toolPath)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "codemodePath"],
            message: "duplicate tool path",
          });
        }
        identities.add(identity);
        modelNames.add(entry.modelName);
        toolPaths.add(toolPath);
      }
    }),
);
export type ToolGatewayCatalog = z.infer<typeof ToolGatewayCatalog>;

export const ToolGatewayCaller = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.enum(["model", "codemode", "http", "mcp", "browser"]),
      subjectId: z.string().min(1).max(1_024),
    })
    .strict(),
);
export type ToolGatewayCaller = z.infer<typeof ToolGatewayCaller>;

/**
 * MCP request `_meta` key naming the attempt surface that issued a call to the
 * first-party server: `model` for a direct model tool call, `codemode` for a
 * Codemode script. Only the worker's own tool gateway sets it, and only for the
 * first-party server. A read reached the model's context only when it says
 * `model`; a Codemode script may keep the output to itself.
 */
export const FIRST_PARTY_MCP_CALLER_META_KEY = "opengeniCaller";

export const AttemptToolCatalog = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(ATTEMPT_TOOL_CATALOG_VERSION),
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      turnId: primitives.uuid,
      attemptId: primitives.uuid,
      executionGeneration: primitives.positiveInteger,
      generation: primitives.positiveInteger,
      digest: sha256,
      createdAt: primitives.string.datetime({ offset: true }),
      /** Native permission ceiling frozen by the worker with this catalog.
       * Absence is legacy/unknown, not permission to derive a larger live set. */
      firstPartyMcpPermissions: z.array(Permission).max(128).optional(),
      entries: z.array(AttemptToolCatalogEntry).max(ATTEMPT_TOOL_CATALOG_MAX_ENTRIES),
    })
    .strict()
    .superRefine((catalog, context) => {
      const identities = new Set<string>();
      const modelNames = new Set<string>();
      const codemodePaths = new Set<string>();
      for (const [index, entry] of catalog.entries.entries()) {
        const identity = `${entry.identity.serverId}\u0000${entry.identity.toolName}`;
        const codemodePath = entry.codemodePath.join(".");
        if (identities.has(identity)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "identity"],
            message: "duplicate tool identity",
          });
        }
        if (modelNames.has(entry.modelName)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "modelName"],
            message: "duplicate model tool name",
          });
        }
        if (codemodePaths.has(codemodePath)) {
          context.addIssue({
            code: "custom",
            path: ["entries", index, "codemodePath"],
            message: "duplicate Codemode tool path",
          });
        }
        identities.add(identity);
        modelNames.add(entry.modelName);
        codemodePaths.add(codemodePath);
      }
    }),
);
export type AttemptToolCatalog = z.infer<typeof AttemptToolCatalog>;

export const AttemptToolCaller = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      kind: z.enum(["model", "codemode"]),
      subjectId: z.string().min(1).max(1_024),
    })
    .strict(),
);
export type AttemptToolCaller = z.infer<typeof AttemptToolCaller>;

export const AttemptToolCall = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      catalogDigest: sha256,
      identity: AttemptToolIdentity,
      arguments: jsonObject,
      caller: AttemptToolCaller,
    })
    .strict(),
);
export type AttemptToolCall = z.infer<typeof AttemptToolCall>;

const McpAnnotations = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().max(256), z.json()).optional(),
);
const McpMeta = /* @__PURE__ */ defineSchema(() =>
  z.record(z.string().max(512), z.json()).optional(),
);

export const AttemptToolTextContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("text"),
      text: primitives.string,
      annotations: McpAnnotations,
      _meta: McpMeta,
    })
    .loose(),
);

export const AttemptToolImageContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("image"),
      data: primitives.string,
      mimeType: z.string().min(1).max(128),
      annotations: McpAnnotations,
      _meta: McpMeta,
    })
    .loose(),
);

export const AttemptToolAudioContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("audio"),
      data: primitives.string,
      mimeType: z.string().min(1).max(128),
      annotations: McpAnnotations,
      _meta: McpMeta,
    })
    .loose(),
);

export const AttemptToolResourceLinkContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("resource_link"),
      name: z.string().min(1).max(1_024),
      title: z.string().max(1_024).optional(),
      uri: z.string().min(1).max(16_384),
      description: z.string().max(32_768).optional(),
      mimeType: z.string().max(128).optional(),
      size: z.number().int().nonnegative().optional(),
      icons: z.array(AttemptToolCatalogIcon).max(16).optional(),
      annotations: McpAnnotations,
      _meta: McpMeta,
    })
    .loose(),
);

const AttemptToolTextResource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      uri: z.string().min(1).max(16_384),
      mimeType: z.string().max(128).optional(),
      text: primitives.string,
      _meta: McpMeta,
    })
    .loose(),
);

const AttemptToolBlobResource = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      uri: z.string().min(1).max(16_384),
      mimeType: z.string().max(128).optional(),
      blob: primitives.string,
      _meta: McpMeta,
    })
    .loose(),
);

export const AttemptToolEmbeddedResourceContent = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      type: z.literal("resource"),
      resource: z.union([AttemptToolTextResource, AttemptToolBlobResource]),
      annotations: McpAnnotations,
      _meta: McpMeta,
    })
    .loose(),
);

export const AttemptToolContent = /* @__PURE__ */ defineSchema(() =>
  z.discriminatedUnion("type", [
    AttemptToolTextContent,
    AttemptToolImageContent,
    AttemptToolAudioContent,
    AttemptToolResourceLinkContent,
    AttemptToolEmbeddedResourceContent,
  ]),
);
export type AttemptToolContent = z.infer<typeof AttemptToolContent>;

/** Exact MCP-shaped result. No output type is fabricated when `outputSchema` is absent. */
export const AttemptToolResult = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      content: z.array(AttemptToolContent).max(ATTEMPT_TOOL_CATALOG_MAX_CONTENT_BLOCKS),
      structuredContent: jsonObject.optional(),
      isError: primitives.optionalBoolean,
      _meta: McpMeta,
    })
    .loose(),
);
export type AttemptToolResult = z.infer<typeof AttemptToolResult>;

export const ToolGatewayResult = AttemptToolResult;
export type ToolGatewayResult = AttemptToolResult;

export const ToolGatewayCallRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.optionalUuid,
      catalogDigest: sha256,
      identity: ToolGatewayIdentity,
      arguments: jsonObject,
      /** Host-owned Site context. Publisher-controlled iframe code cannot set it. */
      siteArtifactId: primitives.optionalUuid,
      siteVersionId: primitives.optionalUuid,
      /** Opaque, server-issued, single-use capability for an approval-required call. */
      approvalToken: primitives.string.regex(/^ogta_[A-Za-z0-9_-]{43}$/u).optional(),
    })
    .strict()
    .superRefine(requireCompleteSiteToolContext),
);
export type ToolGatewayCallRequest = z.infer<typeof ToolGatewayCallRequest>;

export const ToolGatewayApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      catalogDigest: sha256,
      identity: ToolGatewayIdentity,
      arguments: jsonObject,
    })
    .strict(),
);
export type ToolGatewayApprovalRequest = z.infer<typeof ToolGatewayApprovalRequest>;

export const ToolGatewayApprovalResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      catalogDigest: sha256,
      identity: ToolGatewayIdentity,
      approvalToken: primitives.string.regex(/^ogta_[A-Za-z0-9_-]{43}$/u),
      expiresAt: primitives.string.datetime({ offset: true }),
    })
    .strict(),
);
export type ToolGatewayApprovalResponse = z.infer<typeof ToolGatewayApprovalResponse>;

export const ToolGatewayCallResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      catalogDigest: sha256,
      result: ToolGatewayResult,
    })
    .strict(),
);
export type ToolGatewayCallResponse = z.infer<typeof ToolGatewayCallResponse>;

/** A selector, never an authority claim. Symbolic paths use the canonical projection. */
export const ToolGatewayTarget = /* @__PURE__ */ defineSchema(() =>
  z.union([
    z.object({ identity: ToolGatewayIdentity }).strict(),
    z.object({ path: z.array(namespaceSegment).min(2).max(8) }).strict(),
  ]),
);
export type ToolGatewayTarget = z.infer<typeof ToolGatewayTarget>;

const targetContext = {
  siteArtifactId: primitives.optionalUuid,
  siteVersionId: primitives.optionalUuid,
};
export const ToolGatewayResolveRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      target: ToolGatewayTarget,
      ...targetContext,
    })
    .strict()
    .superRefine(requireCompleteSiteToolContext),
);
export type ToolGatewayResolveRequest = z.infer<typeof ToolGatewayResolveRequest>;

export const ToolGatewayResolvedTool = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(1),
      definitionDigest: sha256,
      entry: ToolGatewayCatalogEntry,
    })
    .strict(),
);
export type ToolGatewayResolvedTool = z.infer<typeof ToolGatewayResolvedTool>;

export const ToolGatewayInvokeRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      target: ToolGatewayTarget,
      operationId: primitives.uuid,
      arguments: jsonObject,
      /** Omission explicitly selects the current authorized definition. */
      expectedDefinitionDigest: sha256.optional(),
      approvalToken: primitives.string.regex(/^ogta_[A-Za-z0-9_-]{43}$/u).optional(),
      ...targetContext,
    })
    .strict()
    .superRefine(requireCompleteSiteToolContext),
);
export type ToolGatewayInvokeRequest = z.infer<typeof ToolGatewayInvokeRequest>;

export const ToolGatewayInvokeResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operationId: primitives.uuid,
      tool: ToolGatewayResolvedTool,
      result: ToolGatewayResult,
    })
    .strict(),
);
export type ToolGatewayInvokeResponse = z.infer<typeof ToolGatewayInvokeResponse>;

export const ToolGatewayTargetApprovalRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      identity: ToolGatewayIdentity,
      operationId: primitives.uuid,
      arguments: jsonObject,
      expectedDefinitionDigest: sha256,
      ...targetContext,
    })
    .strict()
    .superRefine(requireCompleteSiteToolContext),
);
export type ToolGatewayTargetApprovalRequest = z.infer<typeof ToolGatewayTargetApprovalRequest>;
export const ToolGatewayTargetApprovalResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      bindingVersion: z.literal(2),
      operationId: primitives.uuid,
      tool: ToolGatewayResolvedTool,
      approvalToken: primitives.string.regex(/^ogta_[A-Za-z0-9_-]{43}$/u),
      expiresAt: primitives.string.datetime({ offset: true }),
    })
    .strict(),
);
export type ToolGatewayTargetApprovalResponse = z.infer<typeof ToolGatewayTargetApprovalResponse>;

/** Bounded compatibility manifest, not workspace discovery. */
export const ToolGatewayManifestRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      identities: z.array(ToolGatewayIdentity).max(256),
      ...targetContext,
    })
    .strict()
    .superRefine(requireCompleteSiteToolContext),
);
export type ToolGatewayManifestRequest = z.infer<typeof ToolGatewayManifestRequest>;
export const ToolGatewayManifestResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(1),
      digest: sha256,
      tools: z.array(ToolGatewayResolvedTool).max(256),
    })
    .strict(),
);
export type ToolGatewayManifestResponse = z.infer<typeof ToolGatewayManifestResponse>;

export const ToolGatewayDeclarationsResponse = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      catalogDigest: sha256,
      moduleSpecifier: z.string().min(1).max(512),
      source: primitives.string.max(16 * 1024 * 1024),
    })
    .strict(),
);
export type ToolGatewayDeclarationsResponse = z.infer<typeof ToolGatewayDeclarationsResponse>;

function requireCompleteSiteToolContext(
  value: { siteArtifactId?: string | undefined; siteVersionId?: string | undefined },
  context: z.RefinementCtx,
): void {
  if ((value.siteArtifactId === undefined) === (value.siteVersionId === undefined)) return;
  context.addIssue({
    code: "custom",
    message: "siteArtifactId and siteVersionId must be provided together",
    path: [value.siteArtifactId === undefined ? "siteArtifactId" : "siteVersionId"],
  });
}

export const CodemodeOperationState = /* @__PURE__ */ defineSchema(() =>
  z.enum([
    "queued",
    "waiting_for_approval",
    "running",
    "completed",
    "failed",
    "outcome_unknown",
    "cancelled",
  ]),
);
export type CodemodeOperationState = z.infer<typeof CodemodeOperationState>;

/**
 * Durable, attempt-fenced Codemode operation. `requestDigest` binds an
 * idempotency key to one exact call; callers may safely poll/retry the same
 * operation id but may never repurpose it.
 */
export const CodemodeOperation = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(CODEMODE_OPERATION_VERSION),
      operationId: primitives.uuid,
      accountId: primitives.uuid,
      workspaceId: primitives.uuid,
      sessionId: primitives.uuid,
      turnId: primitives.uuid,
      attemptId: primitives.uuid,
      executionGeneration: primitives.positiveInteger,
      catalogDigest: sha256,
      requestDigest: sha256,
      identity: AttemptToolIdentity,
      arguments: jsonObject,
      caller: AttemptToolCaller.refine((caller) => caller.kind === "codemode", {
        message: "Codemode operation caller must be codemode",
      }),
      state: CodemodeOperationState,
      /** Present only for clients that acknowledged durable approval continuation. */
      durableApproval: z.literal(true).optional(),
      approvalRequestId: primitives.optionalUuid,
      result: AttemptToolResult.nullable(),
      errorCode: z.string().min(1).max(128).nullable(),
      errorMessage: z.string().min(1).max(4_096).nullable(),
      createdAt: primitives.string.datetime({ offset: true }),
      claimedAt: primitives.string.datetime({ offset: true }).nullable(),
      executionStartedAt: primitives.string.datetime({ offset: true }).nullable(),
      completedAt: primitives.string.datetime({ offset: true }).nullable(),
      updatedAt: primitives.string.datetime({ offset: true }),
    })
    .strict(),
);
export type CodemodeOperation = z.infer<typeof CodemodeOperation>;

export const CodemodeCallRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      /** Opt-in transport capability, never permission to execute. */
      durableApproval: z.literal(true).optional(),
      operationId: primitives.uuid,
      catalogDigest: sha256,
      identity: AttemptToolIdentity,
      arguments: jsonObject,
    })
    .strict(),
);
export type CodemodeCallRequest = z.infer<typeof CodemodeCallRequest>;

export const CodemodeCallSubmission = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      operation: CodemodeOperation,
      dispatch: z.enum(["accepted", "already_running", "terminal", "unavailable", "rejected"]),
    })
    .strict(),
);
export type CodemodeCallSubmission = z.infer<typeof CodemodeCallSubmission>;

/** Tiny NATS wake-up. Postgres, never the broker payload, is durable truth. */
export const CodemodeDispatchRequest = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(CODEMODE_OPERATION_VERSION),
      operationId: primitives.uuid,
      catalogDigest: sha256,
    })
    .strict(),
);
export type CodemodeDispatchRequest = z.infer<typeof CodemodeDispatchRequest>;

export const CodemodeDispatchAck = /* @__PURE__ */ defineSchema(() =>
  z
    .object({
      version: z.literal(CODEMODE_OPERATION_VERSION),
      operationId: primitives.uuid,
      status: z.enum(["accepted", "already_running", "terminal", "unavailable", "rejected"]),
    })
    .strict(),
);
export type CodemodeDispatchAck = z.infer<typeof CodemodeDispatchAck>;

/** Native in-process correlation only; never accepted in tool arguments or transport metadata. */
export type NativeModelSourceContext = { nativeModelSourceKey?: string };

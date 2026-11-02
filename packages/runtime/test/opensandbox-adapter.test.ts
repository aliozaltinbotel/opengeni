import { describe, expect, test } from "bun:test";
import { shell } from "@openai/agents/sandbox";
import type { Tool } from "@openai/agents";
import { createHash } from "node:crypto";
import { createStaticSecretResolver } from "@opengeni/vaults/testing";
import {
  createTurnToolCancellationController,
  wrapCapabilityToolsForTurnCancellation,
} from "../src/sandbox/turn-tool-cancellation";
import {
  prepareSecretExec,
  runWithSecretCarry,
  secretScopeDirectory,
  secretScopeFor,
} from "../src/sandbox/secret-delivery";
import {
  ConnectionConfig,
  DefaultAdapterFactory,
  SandboxApiException,
  type AdapterFactory,
  type CreateSandboxRequest,
  type Endpoint,
} from "@alibaba-group/opensandbox";
import {
  OpenSandboxCommandStreamError,
  withOpenSandboxCommandStreamProof,
} from "../src/sandbox/providers/opensandbox-command-stream";
import {
  Manifest,
  SandboxArchiveError,
  SandboxUnsupportedFeatureError,
} from "@openai/agents/sandbox";
import {
  OpenSandboxClient,
  SandboxConfigError,
  SandboxExactResumeInstanceUnavailableError,
  runWithToolCallCorrelation,
} from "../src/sandbox";
import { archiveRestoreScript } from "../src/sandbox/providers/opensandbox-adapter";
import {
  executeSynchronousCommand,
  synchronousCommandPage,
  observeSynchronousCommand,
} from "../src/sandbox/synchronous-command";
import {
  RoutingSandboxSession,
  RoutingMutationOutcomeUnknownError,
} from "../src/sandbox/routing/routing-session";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = `registry.example.com/opengeni@sha256:${"a".repeat(64)}`;

// The provider's mode number carries octal digits, unlike a local filesystem bitmask.
function permissionModeFromWire(mode: number): number {
  if (!Number.isSafeInteger(mode) || !/^[0-7]+$/u.test(String(mode))) {
    throw new Error(`invalid octal permission mode: ${mode}`);
  }
  return Number.parseInt(String(mode), 8);
}

type FakeFile = { type: "file" | "directory"; data?: Uint8Array; mode?: number };

class FakeOpenSandbox {
  readonly calls: string[] = [];
  readonly executedCommands: string[] = [];
  readonly commandEnvironments: Array<Record<string, string>> = [];
  secretDigestOutput = false;
  secretWriteFailure: Error | null = null;
  secretFileWrites = 0;
  readonly files = new Map<string, FakeFile>();
  readonly interrupted: string[] = [];
  createdRequest: CreateSandboxRequest | null = null;
  sandboxExists = true;
  commandGate: Promise<void> | null = null;
  resolveCommand: (() => void) | null = null;
  commandFailureAfterInit: Error | null = null;
  commandFailureAfterYield: Error | null = null;
  commandStdout = "out";
  commandStderr = "err";
  commandTailStdout = "";
  commandTailStderr = "";
  commandExitCode: number | null = 0;
  commandHasCompletion = true;
  signedEndpointError: Error | null = null;
  filesystemReadError: Error | null = null;
  commandStatus: { running: boolean; exitCode: number | null; content: string; error?: string } = {
    running: false,
    exitCode: 0,
    content: "",
  };
  lifecycleRequestTimeoutSeconds: number | null = null;
  reportedImage = IMAGE;
  reportedExtensions: Record<string, string> = {};

  readonly adapterFactory: AdapterFactory;

  constructor() {
    const self = this;
    const lifecycle = {
      async createSandbox(request: CreateSandboxRequest) {
        self.calls.push("createSandbox");
        self.createdRequest = request;
        self.sandboxExists = true;
        return self.created();
      },
      async getSandbox(id: string) {
        self.calls.push(`getSandbox:${id}`);
        if (!self.sandboxExists) throw self.notFound();
        return self.info(id);
      },
      async listSandboxes() {
        return { items: self.sandboxExists ? [self.info("sbx-1")] : [] };
      },
      async patchSandboxMetadata(id: string) {
        return self.info(id);
      },
      async deleteSandbox(id: string) {
        self.calls.push(`deleteSandbox:${id}`);
        if (!self.sandboxExists) throw self.notFound();
        self.sandboxExists = false;
      },
      async pauseSandbox() {},
      async resumeSandbox() {},
      async renewSandboxExpiration(id: string, request: { expiresAt: string }) {
        self.calls.push(`renewSandboxExpiration:${id}`);
        return { expiresAt: new Date(request.expiresAt) };
      },
      async createSnapshot() {
        throw new Error("not used");
      },
      async getSnapshot() {
        throw new Error("not used");
      },
      async listSnapshots() {
        return { items: [] };
      },
      async deleteSnapshot() {},
      async getSandboxEndpoint(id: string, port: number): Promise<Endpoint> {
        self.calls.push(`getSandboxEndpoint:${id}:${port}`);
        if (!self.sandboxExists) throw self.notFound();
        return {
          endpoint: `proxy.example.test/sandboxes/${id}/${port}`,
          headers: { "x-open-sandbox-route": id },
        };
      },
      async getSignedEndpoint(id: string, port: number, expires: number): Promise<Endpoint> {
        self.calls.push(`getSignedEndpoint:${id}:${port}:${expires}`);
        if (self.signedEndpointError) throw self.signedEndpointError;
        if (!self.sandboxExists) throw self.notFound();
        return {
          endpoint: `ingress.example.test/${id}/${port}/${expires.toString(36)}/sigsigsig`,
        };
      },
      invalidateEndpointCache() {},
    };
    const commands = {
      async run(
        command: string,
        options: { workingDirectory?: string; envs?: Record<string, string> } | undefined,
        handlers: any,
      ) {
        self.executedCommands.push(command);
        self.commandEnvironments.push({ ...options?.envs });
        if (self.secretDigestOutput) {
          const path = options?.envs?.OPENGENI_SECRET_0;
          const bytes = path ? self.files.get(path)?.data : undefined;
          self.commandStdout = bytes
            ? createHash("sha256").update(bytes).digest("hex")
            : "UNRESOLVED_SECRETFILE";
        }
        if (command.includes("__OPENGENI_CONFINED_READ_OK__")) {
          if (!self.sandboxExists) throw self.notFound();
          const root = JSON.parse(/root = ("[^"]*")/u.exec(command)![1]!);
          const relative = JSON.parse(/path = ("[^"]*")/u.exec(command)![1]!);
          const limit = Number(/limit = (\d+)/u.exec(command)![1]);
          const file = self.files.get(`${root}/${relative}`);
          const bytes = file?.data?.slice(0, limit);
          await handlers?.onInit?.({ id: "read-1", timestamp: Date.now() });
          if (bytes && !self.filesystemReadError)
            await handlers?.onStdout?.({
              text: `__OPENGENI_CONFINED_READ_OK__${Buffer.from(bytes).toString("base64")}__OPENGENI_CONFINED_READ_END__`,
              timestamp: Date.now(),
            });
          return {
            id: "read-1",
            logs: { stdout: [], stderr: [] },
            result: [],
            complete: { timestamp: Date.now(), executionTimeMs: 1 },
            exitCode: bytes && !self.filesystemReadError ? 0 : 66,
          };
        }
        const cwd = options?.workingDirectory;
        if (
          cwd &&
          !self.files.has(cwd) &&
          ![...self.files.keys()].some((path) => path.startsWith(`${cwd}/`))
        ) {
          throw new SandboxApiException({
            message: `invalid request, validation error working directory does not exist: ${cwd}: stat ${cwd}: no such file or directory`,
            statusCode: 400,
          });
        }
        self.calls.push("command:run");
        await handlers?.onInit?.({ id: "exec-1", timestamp: Date.now() });
        await handlers?.onStdout?.({ text: self.commandStdout, timestamp: Date.now() });
        await handlers?.onStderr?.({
          text: self.commandStderr,
          timestamp: Date.now(),
          isError: true,
        });
        if (self.commandFailureAfterInit) throw self.commandFailureAfterInit;
        if (self.commandGate) await self.commandGate;
        if (self.commandFailureAfterYield) throw self.commandFailureAfterYield;
        if (self.commandTailStdout)
          await handlers?.onStdout?.({ text: self.commandTailStdout, timestamp: Date.now() });
        if (self.commandTailStderr)
          await handlers?.onStderr?.({
            text: self.commandTailStderr,
            timestamp: Date.now(),
            isError: true,
          });
        return {
          id: "exec-1",
          logs: { stdout: [], stderr: [] },
          result: [],
          ...(self.commandHasCompletion
            ? { complete: { timestamp: Date.now(), executionTimeMs: 1 } }
            : {}),
          exitCode: self.commandExitCode,
          ...(self.commandExitCode
            ? {
                error: {
                  name: "CommandExecutionError",
                  value: String(self.commandExitCode),
                  timestamp: Date.now(),
                  traceback: [],
                },
              }
            : {}),
        };
      },
      async *runStream() {},
      async interrupt(id: string) {
        self.calls.push(`command:interrupt:${id}`);
        self.interrupted.push(id);
        self.resolveCommand?.();
      },
      async getCommandStatus(id: string) {
        self.calls.push(`command:status:${id}`);
        return { id, ...self.commandStatus };
      },
      async getBackgroundCommandLogs() {
        return { content: "" };
      },
      async createSession() {
        return "session";
      },
      async runInSession() {
        throw new Error("not used");
      },
      async deleteSession() {},
    };
    const files = {
      async getFileInfo(paths: string[]) {
        return Object.fromEntries(
          paths.flatMap((path) => {
            const value = self.files.get(path);
            return value
              ? [
                  [
                    path,
                    {
                      path,
                      type: value.type,
                      size: value.data?.byteLength ?? 0,
                    },
                  ],
                ]
              : [];
          }),
        );
      },
      async search() {
        return [];
      },
      async listDirectory({ path }: { path: string }) {
        if (self.filesystemReadError) throw self.filesystemReadError;
        const prefix = path.endsWith("/") ? path : `${path}/`;
        return [...self.files.entries()]
          .filter(
            ([candidate]) =>
              candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"),
          )
          .map(([candidate, value]) => ({ path: candidate, type: value.type }));
      },
      async createDirectories(entries: Array<{ path: string; mode?: number }>) {
        for (const entry of entries)
          self.files.set(entry.path, {
            type: "directory",
            ...(entry.mode === undefined ? {} : { mode: permissionModeFromWire(entry.mode) }),
          });
      },
      async deleteDirectories(paths: string[]) {
        for (const path of paths) {
          for (const candidate of [...self.files.keys()]) {
            if (candidate === path || candidate.startsWith(`${path}/`))
              self.files.delete(candidate);
          }
        }
      },
      async writeFiles(
        entries: Array<{
          path: string;
          data?: string | Uint8Array | ArrayBuffer;
          mode?: number;
        }>,
      ) {
        for (const entry of entries) {
          const data =
            typeof entry.data === "string"
              ? new TextEncoder().encode(entry.data)
              : entry.data instanceof Uint8Array
                ? Uint8Array.from(entry.data)
                : entry.data instanceof ArrayBuffer
                  ? new Uint8Array(entry.data)
                  : new Uint8Array();
          self.files.set(entry.path, {
            type: "file",
            data,
            ...(entry.mode === undefined ? {} : { mode: permissionModeFromWire(entry.mode) }),
          });
          if (entry.path.startsWith("/tmp/opengeni-private/secrets/")) self.secretFileWrites++;
          if (self.secretWriteFailure && entry.path.startsWith("/tmp/opengeni-private/secrets/"))
            throw self.secretWriteFailure;
        }
      },
      async readFile(path: string) {
        return new TextDecoder().decode(self.files.get(path)?.data ?? new Uint8Array());
      },
      async readBytes(path: string, options?: { limit?: number }) {
        if (self.filesystemReadError) throw self.filesystemReadError;
        const bytes = self.files.get(path)?.data ?? new Uint8Array();
        return options?.limit === undefined
          ? Uint8Array.from(bytes)
          : bytes.slice(0, options.limit);
      },
      async *readBytesStream(path: string) {
        yield await this.readBytes(path);
      },
      async deleteFiles(paths: string[]) {
        for (const path of paths) self.files.delete(path);
      },
      async moveFiles(entries: Array<{ src: string; dest: string }>) {
        for (const entry of entries) {
          const value = self.files.get(entry.src);
          if (value) self.files.set(entry.dest, value);
          self.files.delete(entry.src);
        }
      },
      async replaceContents() {},
      async replaceContentsDetailed() {
        return [];
      },
      async setPermissions(entries: Array<{ path: string; mode: number }>) {
        for (const entry of entries) {
          const file = self.files.get(entry.path);
          if (file) file.mode = permissionModeFromWire(entry.mode);
        }
      },
    };
    this.adapterFactory = {
      createLifecycleStack({ connectionConfig }) {
        self.lifecycleRequestTimeoutSeconds = connectionConfig.requestTimeoutSeconds;
        return { sandboxes: lifecycle as any };
      },
      createExecdStack() {
        return {
          commands: commands as any,
          files: files as any,
          health: {
            async ping() {
              self.calls.push("health:ping");
              return true;
            },
          },
          metrics: {
            async getMetrics() {
              return {};
            },
          } as any,
          isolation: {} as any,
        };
      },
      createEgressStack() {
        return {
          egress: {
            async getPolicy() {
              return {};
            },
            async patchRules() {},
            async deleteRules() {},
          } as any,
          credentialVault: {} as any,
        };
      },
    };
  }

  holdCommand(): void {
    this.commandGate = new Promise<void>((resolve) => {
      this.resolveCommand = resolve;
    });
  }

  private created() {
    return {
      id: "sbx-1",
      status: { state: "Creating" },
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      entrypoint: ["tail", "-f", "/dev/null"],
    };
  }

  private info(id: string) {
    return {
      id,
      image: { uri: this.reportedImage },
      entrypoint: ["tail", "-f", "/dev/null"],
      metadata: {},
      extensions: this.reportedExtensions,
      status: { state: "Running" },
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  private notFound(): SandboxApiException {
    return new SandboxApiException({ message: "missing", statusCode: 404 });
  }
}

function createClient(
  fake: FakeOpenSandbox,
  options: {
    poolRef?: string;
    image?: string;
    baseUrl?: string;
    useServerProxy?: boolean;
    signedEndpoints?: boolean;
    signedEndpointTtlSeconds?: number;
    channelBPublicBaseUrl?: string;
  } = {},
): OpenSandboxClient {
  return new OpenSandboxClient({
    baseUrl: options.baseUrl ?? "https://opensandbox.example.test",
    apiKey: "secret-test-key",
    image: options.image ?? IMAGE,
    ttlSeconds: 60,
    useServerProxy: options.useServerProxy ?? true,
    signedEndpoints: options.signedEndpoints,
    signedEndpointTtlSeconds: options.signedEndpointTtlSeconds,
    ...(options.channelBPublicBaseUrl
      ? { channelBPublicBaseUrl: options.channelBPublicBaseUrl }
      : {}),
    readyTimeoutSeconds: 2,
    resourceLimits: { cpu: "1", memory: "1Gi" },
    resourceRequests: { cpu: "250m", memory: "512Mi" },
    environment: { BASE: "base" },
    ...(options.poolRef ? { poolRef: options.poolRef } : {}),
    adapterFactory: fake.adapterFactory,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function heldOutputProvider(exitCode = 0) {
  const fake = new FakeOpenSandbox();
  fake.commandStdout = "prefix";
  fake.commandStderr = "";
  fake.commandTailStdout = "x".repeat(2_000);
  fake.commandTailStderr = "y".repeat(2_000);
  fake.commandExitCode = exitCode;
  fake.holdCommand();
  return fake;
}

function wireEvent(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ timestamp: 1, ...event })}\n\n`;
}

/** Real SDK command/status/interrupt adapters and HTTP streams; only the
 * unrelated lifecycle, health and filesystem services are fixture-backed. */
async function wireSession(
  body: string | Uint8Array | ((command: string) => ReadableStream),
  contentType = "text/event-stream",
  transport: { method?: string; useRequest?: boolean; filesystem?: boolean } = {},
) {
  const permissionRequests: Array<{ operation: string; path: string; mode: number }> = [];
  const fileModes = new Map<string, number>();
  const uploadedBytes = new Map<string, Uint8Array>();
  const starts: string[] = [];
  const statusIds: string[] = [];
  const interrupted: string[] = [];
  const statuses = new Map<string, { id?: string; running: boolean; exit_code: number | null }>();
  let onStatus: ((id: string) => void) | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (transport.filesystem && request.method === "POST" &&
          ["/directories", "/files/permissions", "/files/upload"].includes(url.pathname)) {
        const entries: Array<{ path: string; mode?: number }> = [];
        if (url.pathname === "/files/upload") {
          const form = await request.formData();
          const metadata = form.get("metadata");
          if (!(metadata instanceof Blob)) return new Response("missing metadata", { status: 400 });
          const entry: unknown = JSON.parse(await metadata.text());
          if (typeof entry !== "object" || entry === null || !("path" in entry) ||
              typeof entry.path !== "string" ||
              ("mode" in entry && entry.mode !== undefined && typeof entry.mode !== "number")) {
            return new Response("invalid metadata", { status: 400 });
          }
          entries.push({ path: entry.path, ...("mode" in entry && typeof entry.mode === "number" ? { mode: entry.mode } : {}) });
          const file = form.get("file");
          if (file instanceof Blob) uploadedBytes.set(entry.path, new Uint8Array(await file.arrayBuffer()));
        } else {
          const body: unknown = await request.json();
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            return new Response("invalid permission map", { status: 400 });
          }
          for (const [path, permission] of Object.entries(body)) {
            if (typeof permission !== "object" || permission === null ||
                !("mode" in permission) || typeof permission.mode !== "number") {
              return new Response("invalid permission", { status: 400 });
            }
            entries.push({ path, mode: permission.mode });
          }
        }
        for (const entry of entries) {
          if (entry.mode === undefined) continue;
          // Execd parses the JSON number's digits in base 8, not as a numeric Unix bitmask.
          if (!Number.isSafeInteger(entry.mode) || !/^[0-7]+$/u.test(String(entry.mode))) {
            return Response.json({ message: `strconv.ParseUint: parsing "${entry.mode}": invalid syntax` }, { status: 400 });
          }
          permissionRequests.push({ operation: url.pathname, path: entry.path, mode: entry.mode });
          fileModes.set(entry.path, Number.parseInt(String(entry.mode), 8));
        }
        return new Response(null, { status: 200 });
      }
      if (transport.filesystem && url.pathname === "/directories" && request.method === "DELETE") {
        for (const path of url.searchParams.getAll("path")) {
          for (const entry of fileModes.keys()) if (entry === path || entry.startsWith(`${path}/`)) {
            fileModes.delete(entry);
            uploadedBytes.delete(entry);
          }
        }
        return new Response(null, { status: 200 });
      }
      if (url.pathname === "/command" && request.method === "POST") {
        const { command } = (await request.json()) as { command: string };
        starts.push(command);
        return new Response(typeof body === "function" ? body(command) : body, {
          headers: { "content-type": contentType },
        });
      }
      if (url.pathname === "/command" && request.method === "DELETE") {
        interrupted.push(url.searchParams.get("id")!);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/command/status/")) {
        const id = decodeURIComponent(url.pathname.slice("/command/status/".length));
        statusIds.push(id);
        const status = statuses.get(id) ?? { id, running: true, exit_code: null };
        onStatus?.(id);
        return Response.json(status);
      }
      return new Response("unexpected fixture request", { status: 404 });
    },
  });
  const fake = new FakeOpenSandbox();
  const originalStack = fake.adapterFactory.createExecdStack.bind(fake.adapterFactory);
  fake.adapterFactory.createExecdStack = (options) => {
    const commandFetch = options.connectionConfig.sseFetch;
    const methodFetch = ((input, init) => {
      const requestInit = { ...init, method: transport.method };
      return transport.useRequest
        ? commandFetch(new Request(input, requestInit))
        : commandFetch(input, requestInit);
    }) as typeof fetch;
    const real = new DefaultAdapterFactory().createExecdStack({
      ...options, execdBaseUrl: server.url.origin,
    });
    return {
      ...originalStack(options),
      ...(transport.filesystem ? { files: real.files } : {}),
      commands: new DefaultAdapterFactory().createExecdStack({
        ...options,
        execdBaseUrl: server.url.origin,
        ...(transport.method
          ? {
              connectionConfig: new Proxy(options.connectionConfig, {
                get(target, property) {
                  return property === "sseFetch"
                    ? methodFetch
                    : Reflect.get(target, property, target);
                },
              }),
            }
          : {}),
      }).commands,
    };
  };
  const session = await createClient(fake).create();
  return {
    session,
    permissionRequests,
    fileModes,
    uploadedBytes,
    starts,
    statusIds,
    interrupted,
    statuses,
    onStatus(callback: (id: string) => void) {
      onStatus = callback;
    },
    files() {
      return new DefaultAdapterFactory().createExecdStack({
        connectionConfig: new ConnectionConfig({ domain: server.url.origin }),
        execdBaseUrl: server.url.origin,
      }).files;
    },
    commands() {
      return withOpenSandboxCommandStreamProof(new DefaultAdapterFactory()).createExecdStack({
        connectionConfig: new ConnectionConfig({ domain: server.url.origin }),
        execdBaseUrl: server.url.origin,
      }).commands;
    },
    async close() {
      await session.close();
      await server.stop(true);
    },
  };
}

describe("OpenSandbox default wire proof", () => {
  test("secretfile permissions use octal digits through the real filesystem HTTP adapter", async () => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
      wireEvent({ type: "execution_complete", execution_time: 1 }),
      "text/event-stream", { filesystem: true },
    );
    const resolver = createStaticSecretResolver({ "id:6cc2b8aa-1a66-4df7-8ef0-6b64794b7893": "FAKEVALUE" });
    const prepared = await prepareSecretExec("sha256sum -- '{{secretfile:id:6cc2b8aa-1a66-4df7-8ef0-6b64794b7893}}'", {
      resolver, dialect: "posix", use: { surface: "shell", toolName: "exec_command" },
    });
    if (!prepared) throw new Error("the fixture must prepare the secret reference");
    try {
      for (const mode of [448, 384]) {
        await expect(wire.files().createDirectories([{ path: "/tmp/invalid-mode", mode }]))
          .rejects.toThrow(`strconv.ParseUint: parsing "${mode}": invalid syntax`);
      }
      const result = await runWithSecretCarry(prepared.carry, () => wire.session.exec({ cmd: prepared.text, yieldTimeMs: 1000 }));
      expect(result.exitCode).toBe(0);
      const directory = secretScopeDirectory(secretScopeFor(resolver));
      expect(wire.permissionRequests.map(({ operation, mode }) => ({ operation, mode }))).toEqual([
        { operation: "/directories", mode: 755 }, // declared workspace root, SDK default
        { operation: "/directories", mode: 700 },
        { operation: "/files/permissions", mode: 700 },
        { operation: "/files/upload", mode: 600 },
      ]);
      expect(wire.fileModes.get(directory)).toBe(0o700);
      const file = [...wire.uploadedBytes.keys()][0];
      if (file === undefined) throw new Error("the fixture must upload a secret file");
      expect(wire.fileModes.get(file)).toBe(0o600);
      expect(new TextDecoder().decode(wire.uploadedBytes.get(file))).toBe("FAKEVALUE");
      expect(wire.starts).toHaveLength(1);
      expect(wire.starts[0]).not.toContain("FAKEVALUE");
      await wire.session.clearSecretFilesForAttempt();
      expect(wire.fileModes.has(directory)).toBe(false);
      expect(wire.uploadedBytes.size).toBe(0);
    } finally { await wire.close(); }
  });

  test("manifest permissions preserve Unix mode bits across the filesystem HTTP API", async () => {
    const wire = await wireSession("", "text/event-stream", { filesystem: true });
    try {
      await wire.session.materializeEntry({ path: "private.txt", entry: { type: "file", content: "fixture", permissions: "-rw-r-----" } });
      expect(wire.permissionRequests.at(-1)).toEqual({ operation: "/files/permissions", path: "/workspace/private.txt", mode: 640 });
      expect(wire.fileModes.get("/workspace/private.txt")).toBe(0o640);
    } finally { await wire.close(); }
  });

  test.each([
    ["array exit", { ename: "CommandExecutionError", evalue: ["0"], traceback: [] }],
    ["array name", { ename: ["CommandExecutionError"], evalue: "0", traceback: [] }],
    ["object trace", { ename: "CommandExecutionError", evalue: "0", traceback: [{}] }],
    ["numeric exit", { ename: "CommandExecutionError", evalue: 0, traceback: [] }],
    ["conflicting exit aliases", { ename: "CommandExecutionError", evalue: "0", value: "7" }],
    ["conflicting name aliases", { ename: "CommandExecutionError", name: "Other", evalue: "0" }],
    ["shadowed malformed alias", { ename: "CommandExecutionError", evalue: "0", value: [] }],
    ["null primary alias", { ename: "CommandExecutionError", evalue: null, value: "0" }],
  ] as const)(
    "malformed error DTO %s cannot be coerced into terminal success",
    async (_label, error) => {
      const wire = await wireSession(
        wireEvent({ type: "init", text: "exec-original" }) +
          wireEvent({ type: "stdout", text: "prefix" }) +
          wireEvent({ type: "error", error }) +
          wireEvent({ type: "execution_complete", execution_time: 1 }),
      );
      try {
        const initial = await runWithToolCallCorrelation("wire-original", () =>
          wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
        );
        const page = synchronousCommandPage(wire.session, initial);
        expect(page).toMatchObject({
          stdout: "prefix",
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        await expect(
          observeSynchronousCommand(page, async () => {
            throw new Error("must not poll unknown bytes");
          }),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
        expect(wire.interrupted).toEqual(["exec-original"]);
        expect(wire.session.hasRetainedProcess(1)).toBe(true);
        const running = await wire.session.writeStdinForProcessControl({ sessionId: 1, chars: "" });
        const incomplete = synchronousCommandPage(wire.session, running, 1);
        expect(incomplete).toMatchObject({
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        await wire.session.acknowledgeCommandOutput(running);
        expect(wire.session.getSynchronousCommandOutput(running)).toBe(incomplete);
        wire.statuses.set("exec-original", { id: "exec-original", running: false, exit_code: 7 });
        const terminal = await wire.session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
        });
        expect(synchronousCommandPage(wire.session, terminal, 1)).toMatchObject({
          exitCode: 7,
          collectionUnavailable: true,
        });
        expect(wire.session.hasRetainedProcess(1)).toBe(false);
        expect(wire.statusIds).toEqual(["exec-original", "exec-original"]);
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test.each([
    ["array envelope", []],
    ["empty envelope", {}],
    ["unknown-only envelope", { other: "7" }],
    ["array primary value", { ename: "CommandExecutionError", evalue: ["0"] }],
    ["nested primary value", { evalue: { value: "0" } }],
    ["numeric primary value", { evalue: 0 }],
    ["boolean primary value", { evalue: false }],
    ["null primary value", { evalue: null }],
    ["array primary name", { ename: ["CommandExecutionError"], evalue: "0" }],
    ["nested primary name", { ename: { name: "CommandExecutionError" }, evalue: "0" }],
    ["numeric name alias", { name: 7, value: "0" }],
    ["array value alias", { name: "CommandExecutionError", value: ["0"] }],
    ["nested value alias", { name: "CommandExecutionError", value: { value: "0" } }],
    ["string traceback", { evalue: "0", traceback: "trace" }],
    ["object traceback", { evalue: "0", traceback: {} }],
    ["null traceback", { evalue: "0", traceback: null }],
    ["numeric traceback entry", { evalue: "0", traceback: [0] }],
    ["object traceback entry", { evalue: "0", traceback: [{}] }],
    ["array traceback entry", { evalue: "0", traceback: [[]] }],
    ["null traceback entry", { evalue: "0", traceback: [null] }],
    ["conflicting value aliases", { evalue: "0", value: "7" }],
    ["conflicting name aliases", { ename: "First", name: "Second", evalue: "0" }],
    ["malformed unused alias", { evalue: "0", value: {} }],
  ] as const)("public SDK error DTO %s is rejected before coercion", async (_label, error) => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "error", error }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      const events = [];
      const read = async () => {
        for await (const event of wire.commands().runStream("original once")) events.push(event);
      };
      await expect(read()).rejects.toBeInstanceOf(OpenSandboxCommandStreamError);
      expect(events).toEqual([expect.objectContaining({ type: "init", text: "exec-original" })]);
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test.each([
    ["wire names", { ename: "CommandExecutionError", evalue: "7", traceback: ["first", "second"] }],
    ["SDK aliases", { name: "CommandExecutionError", value: "7", traceback: [] }],
    ["mixed value alias", { ename: "CommandExecutionError", value: "7" }],
    ["mixed name alias", { name: "CommandExecutionError", evalue: "7" }],
    [
      "agreeing aliases",
      { ename: "CommandExecutionError", name: "CommandExecutionError", evalue: "7", value: "7" },
    ],
    ["omitted name and traceback", { evalue: "7" }],
    ["omitted primary name and traceback", { value: "7" }],
  ] as const)("documented command error %s preserves nonzero exit", async (_label, error) => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "stdout", text: "prefix" }) +
        wireEvent({ type: "error", error }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      expect(
        await executeSynchronousCommand(wire.session, { cmd: "original once", maxOutputTokens: 1 }),
      ).toMatchObject({ stdout: "prefix", stderr: "", exitCode: 7 });
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test.each([
    { ename: "TypeError" },
    { name: "TypeError" },
    { traceback: ["a documented trace"] },
    { evalue: "name is not defined" },
    { ename: "", name: "", evalue: "", value: "", traceback: [] },
  ])("optional documented nonnumeric error %j remains a valid wire event", async (error) => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "error", error }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      const events = [];
      for await (const event of wire.commands().runStream("original once")) events.push(event);
      expect(events[1]).toMatchObject({ type: "error", error });
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test.each([
    { method: "post", useRequest: false },
    { method: "POST", useRequest: false },
    { method: "post", useRequest: true },
  ])("Fetch-normalized POST %j cannot bypass multiline command proof", async (transport) => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        'data: {"type":"stdout",\ndata: "text":"first\\nsecond"}\n\n' +
        'data: {"type":"error",\ndata: "error":{"ename":"CommandExecutionError","evalue":"7","traceback":[]}}\n\n' +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
      "text/event-stream",
      transport,
    );
    try {
      expect(
        await executeSynchronousCommand(wire.session, { cmd: "original once", maxOutputTokens: 1 }),
      ).toMatchObject({ stdout: "first\nsecond", stderr: "", exitCode: 7 });
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test("legal multiline SSE preserves output and a nonzero execution error", async () => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        'data: {"type":"stdout",\r\ndata: "text":"first\\nsecond ☃"}\r\n\r\n' +
        'data: {"type":"error",\ndata: "error":{"ename":"CommandExecutionError","evalue":"7","traceback":[]}}\n\n' +
        wireEvent({ type: "stderr", text: "separate" }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      expect(
        await executeSynchronousCommand(wire.session, { cmd: "original once", maxOutputTokens: 1 }),
      ).toMatchObject({ stdout: "first\nsecond ☃", stderr: "separate", exitCode: 7 });
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test.each(["json", "utf8", "truncated", "missing-completion"] as const)(
    "accepted malformed %s wire cannot authorize synchronous success",
    async (mode) => {
      const init = wireEvent({ type: "init", text: "exec-original" });
      const complete = wireEvent({ type: "execution_complete", execution_time: 1 });
      let body: string | Uint8Array =
        mode === "json"
          ? `${init}data: {not json}\n\n${complete}`
          : mode === "truncated"
            ? `${init}${complete.trimEnd()}\n`
            : `${init}${wireEvent({ type: "stdout", text: "prefix" })}`;
      if (mode === "utf8")
        body = new Uint8Array([
          ...new TextEncoder().encode(`${init}data: {"type":"stdout","text":"`),
          0xc3,
          0x28,
          ...new TextEncoder().encode(`"}\n\n${complete}`),
        ]);
      const wire = await wireSession(body);
      try {
        const initial = await runWithToolCallCorrelation("wire-original", () =>
          wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
        );
        expect(initial.sessionId).toBe(1);
        expect(synchronousCommandPage(wire.session, initial)).toMatchObject({
          exitCode: null,
          collectionUnavailable: true,
        });
        expect(wire.session.hasRetainedProcess(1)).toBe(true);
        expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
        expect(wire.interrupted).toEqual(["exec-original"]);
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test("contradictory init retains and interrupts the first authenticated execution", async () => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "stdout", text: "prefix" }) +
        wireEvent({ type: "init", text: "exec-other" }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      const initial = await runWithToolCallCorrelation("wire-original", () =>
        wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
      );
      expect(initial.sessionId).toBe(1);
      expect(synchronousCommandPage(wire.session, initial)).toMatchObject({
        stdout: "prefix",
        collectionUnavailable: true,
      });
      expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
      expect(wire.interrupted).toEqual(["exec-original"]);
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test.each(["foreign", "missing"] as const)(
    "%s terminal status identity cannot retire the original execution",
    async (mode) => {
      const wire = await wireSession(wireEvent({ type: "init", text: "exec-original" }));
      try {
        const initial = await runWithToolCallCorrelation("wire-original", () =>
          wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
        );
        wire.statuses.set("exec-original", {
          ...(mode === "foreign" ? { id: "exec-other" } : {}),
          running: false,
          exit_code: 0,
        });
        await expect(
          wire.session.writeStdinForProcessControl({ sessionId: initial.sessionId!, chars: "" }),
        ).rejects.toThrow("identity");
        expect(wire.session.hasRetainedProcess(initial.sessionId!)).toBe(true);
        expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
        expect(wire.interrupted).toEqual(["exec-original"]);
        expect(wire.statusIds).toEqual(["exec-original"]);
        wire.statuses.set("exec-original", { id: "exec-original", running: true, exit_code: null });
        const running = await wire.session.writeStdinForProcessControl({ sessionId: 1, chars: "" });
        const partial = synchronousCommandPage(wire.session, running, 1);
        expect(partial).toMatchObject({
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        await wire.session.acknowledgeCommandOutput(running);
        expect(wire.session.getSynchronousCommandOutput(running)).toBe(partial);
        wire.statuses.set("exec-original", { id: "exec-original", running: false, exit_code: 7 });
        const terminal = await wire.session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
        });
        const proof = synchronousCommandPage(wire.session, terminal, 1);
        expect(proof).toMatchObject({ exitCode: 7, collectionUnavailable: true });
        expect(proof.sessionId).toBeUndefined();
        expect(wire.session.hasRetainedProcess(1)).toBe(false);
        await expect(observeSynchronousCommand(partial, async () => proof)).rejects.toMatchObject({
          code: "synchronous_command_outcome_unknown",
        });
        expect(wire.statusIds).toEqual(["exec-original", "exec-original", "exec-original"]);
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test.each([0, 7])(
    "byte-fragmented SSE, repeated identical init and exit %s remain lossless",
    async (exitCode) => {
      const bytes = new TextEncoder().encode(
        ": heartbeat\r\n" +
          wireEvent({ type: "init", text: "exec-original", id: "exec-original" }) +
          wireEvent({ type: "init", text: "exec-original" }) +
          'event: output\rid: event-cursor\rretry: 1\rdata: {"type":"stdout",\rdata: "text":"☃\\n尾"}\r\r' +
          wireEvent({ type: "stderr", text: "err ☃" }) +
          (exitCode
            ? wireEvent({
                type: "error",
                error: { ename: "CommandExecutionError", evalue: String(exitCode), traceback: [] },
              })
            : "") +
          wireEvent({ type: "execution_complete", id: "exec-original", execution_time: 1 }),
      );
      const wire = await wireSession(() => {
        let cursor = 0;
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (cursor === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(cursor, ++cursor));
          },
        });
      });
      try {
        expect(
          await executeSynchronousCommand(wire.session, {
            cmd: "original once",
            maxOutputTokens: 1,
          }),
        ).toMatchObject({ stdout: "☃\n尾", stderr: "err ☃", exitCode });
        expect(wire.starts).toEqual(["original once"]);
        expect(wire.statusIds).toEqual([]);
      } finally {
        await wire.close();
      }
    },
  );

  test.each(["stdout", "execution_complete"])(
    "contradictory %s identity cannot authenticate output or exit",
    async (type) => {
      const wire = await wireSession(
        wireEvent({ type: "init", text: "exec-original" }) +
          wireEvent({ type: "stdout", text: "prefix" }) +
          wireEvent({ type, id: "exec-other", text: "foreign", execution_time: 1 }) +
          (type === "stdout" ? wireEvent({ type: "execution_complete", execution_time: 1 }) : ""),
      );
      try {
        const result = await runWithToolCallCorrelation("wire-original", () =>
          wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
        );
        expect(synchronousCommandPage(wire.session, result)).toMatchObject({
          stdout: "prefix",
          stderr: "",
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
        expect(wire.interrupted).toEqual(["exec-original"]);
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test("malformed wire without init stays unknown rather than becoming an unstarted failure", async () => {
    const wire = await wireSession(
      `data: {not json}\n\n${wireEvent({ type: "execution_complete" })}`,
    );
    try {
      const result = await runWithToolCallCorrelation("wire-original", () =>
        wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
      );
      expect(synchronousCommandPage(wire.session, result)).toMatchObject({
        sessionId: 1,
        exitCode: null,
        collectionUnavailable: true,
      });
      expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(false);
      await expect(
        wire.session.writeStdinForProcessControl({ sessionId: 1, chars: "" }),
      ).rejects.toThrow("identity");
      expect(wire.session.hasRetainedProcess(1)).toBe(true);
      expect(wire.starts).toEqual(["original once"]);
      expect(wire.statusIds).toEqual([]);
      expect(wire.interrupted).toEqual([]);
    } finally {
      await wire.close();
    }
  });

  test("archive completion polling ignores foreign terminal status until original proof", async () => {
    const wire = await wireSession(wireEvent({ type: "init", text: "exec-original" }));
    const firstQuery = deferred();
    wire.statuses.set("exec-original", { id: "exec-other", running: false, exit_code: 0 });
    wire.onStatus(() => firstQuery.resolve());
    try {
      let returned = false;
      const pending = wire.session.persistWorkspaceTar().then(
        () => {
          returned = true;
          return null;
        },
        (error: unknown) => {
          returned = true;
          return error;
        },
      );
      await firstQuery.promise;
      await Promise.resolve();
      expect(returned).toBe(false);
      wire.statuses.set("exec-original", { id: "exec-original", running: false, exit_code: 7 });
      expect(await pending).toBeInstanceOf(SandboxArchiveError);
      expect(wire.starts).toHaveLength(1);
      expect(wire.statusIds).toEqual(["exec-original", "exec-original"]);
    } finally {
      await wire.close();
    }
  });

  test("concurrent default streams retain independent identity, output and recovery", async () => {
    const release = deferred();
    const entered = deferred();
    let requests = 0;
    const wire = await wireSession(
      (command) =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            const event = (value: Record<string, unknown>) =>
              controller.enqueue(new TextEncoder().encode(wireEvent(value)));
            event({ type: "init", text: `exec-${command}` });
            event({ type: "stdout", text: command });
            if (++requests === 2) entered.resolve();
            void release.promise.then(() => {
              if (command !== "lost") {
                event({ type: "stderr", text: "separate" });
                event({ type: "execution_complete", execution_time: 1 });
              }
              controller.close();
            });
          },
        }),
    );
    try {
      const good = wire.session.exec({ cmd: "good", yieldTimeMs: 50 });
      const lost = runWithToolCallCorrelation("lost-wire", () =>
        wire.session.exec({ cmd: "lost", yieldTimeMs: 50 }),
      );
      await entered.promise;
      const [goodInitial, lostInitial] = await Promise.all([good, lost]);
      const goodPage = synchronousCommandPage(wire.session, goodInitial);
      const lostPage = synchronousCommandPage(wire.session, lostInitial);
      expect(goodPage.stdout).toBe("good");
      expect(lostPage.stdout).toBe("lost");
      release.resolve();
      expect(
        await observeSynchronousCommand(goodPage, async (sessionId) =>
          synchronousCommandPage(
            wire.session,
            await wire.session.writeStdinForProcessControl({
              sessionId,
              chars: "",
              yieldTimeMs: 1_000,
            }),
            sessionId,
          ),
        ),
      ).toMatchObject({ stdout: "good", stderr: "separate", exitCode: 0 });
      const lostRead = await wire.session.writeStdinForProcessControl({
        sessionId: lostInitial.sessionId!,
        chars: "",
        yieldTimeMs: 1_000,
      });
      expect(synchronousCommandPage(wire.session, lostRead, lostInitial.sessionId!)).toMatchObject({
        collectionUnavailable: true,
      });
      expect(await wire.session.cancelExecCommand("lost-wire:0")).toBe(true);
      expect(wire.interrupted).toEqual(["exec-lost"]);
      wire.statuses.set("exec-lost", { id: "exec-lost", running: false, exit_code: 7 });
      const terminal = await wire.session.writeStdinForProcessControl({
        sessionId: lostInitial.sessionId!,
        chars: "",
      });
      expect(synchronousCommandPage(wire.session, terminal, lostInitial.sessionId!)).toMatchObject({
        exitCode: 7,
        collectionUnavailable: true,
      });
      expect(wire.statusIds.length).toBeGreaterThan(0);
      expect(new Set(wire.statusIds)).toEqual(new Set(["exec-lost"]));
      expect(wire.starts.toSorted()).toEqual(["good", "lost"]);
    } finally {
      release.resolve();
      await wire.close();
    }
  });

  test.each(["application/x-ndjson", "text/event-stream"])(
    "SDK-supported NDJSON output under %s and nonzero error remain lossless",
    async (contentType) => {
      const wire = await wireSession(
        [
          { type: "init", text: "exec-original" },
          { type: "stdout", text: "☃\n尾" },
          { type: "stderr", text: "separate" },
          { type: "error", error: { ename: "CommandExecutionError", evalue: "7", traceback: [] } },
          { type: "execution_complete", execution_time: 1 },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n"),
        contentType,
      );
      try {
        expect(
          await executeSynchronousCommand(wire.session, {
            cmd: "original once",
            maxOutputTokens: 1,
          }),
        ).toMatchObject({ stdout: "☃\n尾", stderr: "separate", exitCode: 7 });
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test.each(["invalid-json", "trailing-utf8", "unframed-completion"] as const)(
    "completion followed by %s cannot prove stream EOF",
    async (mode) => {
      const prefix =
        wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "stdout", text: "prefix" });
      const complete = wireEvent({ type: "execution_complete", execution_time: 1 });
      const body =
        mode === "trailing-utf8"
          ? new Uint8Array([...new TextEncoder().encode(prefix + complete), 0xe2, 0x98])
          : mode === "invalid-json"
            ? `${prefix}${complete}data: {not json}\n\n`
            : `${prefix}data: {"type":"execution_complete"}`;
      const wire = await wireSession(body);
      try {
        const initial = await runWithToolCallCorrelation("wire-original", () =>
          wire.session.exec({ cmd: "original once", yieldTimeMs: 1_000 }),
        );
        const page = synchronousCommandPage(wire.session, initial);
        expect(page).toMatchObject({
          stdout: "prefix",
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        await expect(
          observeSynchronousCommand(page, async () => {
            throw new Error("must not poll unknown bytes");
          }),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(await wire.session.cancelExecCommand("wire-original:0")).toBe(true);
        expect(wire.interrupted).toEqual(["exec-original"]);
        expect(wire.starts).toEqual(["original once"]);
      } finally {
        await wire.close();
      }
    },
  );

  test("public runStream receives legal multiline events through the same strict wire seam", async () => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        'data: {"type":"stdout",\ndata: "text":"first\\nsecond"}\n\n' +
        'data: {"type":"error",\ndata: "error":{"ename":"CommandExecutionError","evalue":"7","traceback":[]}}\n\n' +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      const events = [];
      for await (const event of wire.commands().runStream("original once")) events.push(event);
      expect(events).toHaveLength(4);
      expect(events[1]).toMatchObject({ type: "stdout", text: "first\nsecond" });
      expect(events[2]).toMatchObject({ type: "error", error: { evalue: "7" } });
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test("public runStream rejects malformed events rather than silently skipping them", async () => {
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        `data: {not json}\n\n${wireEvent({ type: "execution_complete", execution_time: 1 })}`,
    );
    try {
      const events = [];
      const read = async () => {
        for await (const event of wire.commands().runStream("original once")) events.push(event);
      };
      await expect(read()).rejects.toBeInstanceOf(OpenSandboxCommandStreamError);
      expect(events).toEqual([expect.objectContaining({ type: "init", text: "exec-original" })]);
      expect(wire.starts).toEqual(["original once"]);
    } finally {
      await wire.close();
    }
  });

  test("large default wire output remains separate and complete at presentation token limit one", async () => {
    const stdout = `first\r\n${"☃".repeat(400_000)}tail`;
    const stderr = `err\r\n${"尾".repeat(400_000)}tail`;
    const wire = await wireSession(
      wireEvent({ type: "init", text: "exec-original" }) +
        wireEvent({ type: "stdout", text: stdout }) +
        wireEvent({ type: "stderr", text: stderr }) +
        wireEvent({
          type: "error",
          error: { ename: "CommandExecutionError", evalue: "7", traceback: [] },
        }) +
        wireEvent({ type: "execution_complete", execution_time: 1 }),
    );
    try {
      expect(
        await executeSynchronousCommand(wire.session, { cmd: "original once", maxOutputTokens: 1 }),
      ).toMatchObject({ stdout, stderr, exitCode: 7 });
      expect(wire.starts).toEqual(["original once"]);
      expect(wire.statusIds).toEqual([]);
    } finally {
      await wire.close();
    }
  });
});

describe("OpenSandbox adapter", () => {
  test("SDK-owned shell delivers secretfile off-command and clears the attempt directory", async () => {
    const fake = new FakeOpenSandbox();
    fake.secretDigestOutput = true;
    const session = await createClient(fake).create();
    const syntheticValue = "synthetic-noncredential-file-fixture";
    const resolver = createStaticSecretResolver({ Fixture: syntheticValue }, { enabled: true });
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
    });
    const capability = shell();
    wrapCapabilityToolsForTurnCancellation(capability as never, controller);
    const tools = capability
      .clone()
      .bind(session as never)
      .tools() as Tool<unknown>[];
    const exec = tools.find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === "exec_command",
    )!;
    const recordedInputs: string[] = [];
    const originalExec = session.execCommand.bind(session);
    session.execCommand = async (args) => {
      recordedInputs.push(args.cmd);
      return await originalExec(args);
    };
    const original =
      "node -e 'require(\"node:fs\").readFileSync(process.argv[1])' '{{secretfile:Fixture}}'";
    try {
      const result = await exec.invoke(
        {} as never,
        JSON.stringify({ cmd: original, tty: false, yield_time_ms: 30000 }),
        { toolCall: { callId: "secretfile-sdk-owned" } } as never,
      );
      expect(result).toContain(createHash("sha256").update(syntheticValue).digest("hex"));
      expect(recordedInputs).toEqual([original]);
      expect(JSON.stringify(session.state)).not.toContain(syntheticValue);
      expect(fake.executedCommands).toHaveLength(1);
      expect(fake.executedCommands[0]).not.toContain("{{secretfile:");
      expect(fake.executedCommands[0]).not.toContain(syntheticValue);
      expect(session.state.environment).toEqual({ BASE: "base" });
      const directory = secretScopeDirectory(secretScopeFor(resolver));
      const path = fake.commandEnvironments[0]?.OPENGENI_SECRET_0;
      expect(path?.startsWith(`${directory}/`)).toBe(true);
      expect(fake.files.get(directory)?.mode).toBe(0o700);
      expect(fake.files.get(path!)?.mode).toBe(0o600);
      expect(resolver.calls).toHaveLength(1);
      await controller.waitForQuiescence();
      await controller.clearSecretFiles!();
      expect([...fake.files.keys()].some((path) => path.startsWith(directory))).toBe(false);
    } finally {
      await session.close();
    }
  });
  test.each([null, "posix"] as const)(
    "routed OpenSandbox has one physical secret delivery owner (%s splice)",
    async (dialect) => {
      const fake = new FakeOpenSandbox();
      const session = await createClient(fake).create();
      const backend = { session, sandboxId: "sbx-1", kind: "opensandbox", activeEpoch: 0 };
      const route = new RoutingSandboxSession({
        defaultResolved: backend,
        readPointer: async () => ({ activeSandboxId: "sbx-1", activeEpoch: 0 }),
        resolveActiveBackend: async () => backend,
        beforeMutation: async () => "admitted",
        afterMutation: async () => {},
      });
      const resolver = createStaticSecretResolver(
        { Fixture: "synthetic-noncredential-route-fixture", Otp: "JBSWY3DPEHPK3PXP" },
        { enabled: true },
      );
      let totpMaterializations = 0;
      const resolve = resolver.resolve.bind(resolver);
      resolver.resolve = async (refs, use) => {
        const values = await resolve(refs, use);
        for (const value of values.values()) {
          if (value.material.type !== "totp") continue;
          const params = value.material.params;
          value.material = {
            type: "totp",
            get params() {
              totpMaterializations++;
              return params;
            },
          };
        }
        return values;
      };
      const command = "test -f '{{secretfile:Fixture}}'; test -n '{{secret:Otp/otp}}'";
      const prepared = await prepareSecretExec(command, {
        resolver,
        dialect,
        use: { surface: "shell", toolName: "exec_command" },
      });
      try {
        const result = await runWithSecretCarry(prepared!.carry, () =>
          route.execCommand({ cmd: prepared!.text, tty: false, yieldTimeMs: 30000 }),
        );
        expect(result).toContain("Process exited with code 0");
        expect(fake.executedCommands).toHaveLength(1);
        expect(fake.secretFileWrites).toBe(1);
        expect(totpMaterializations).toBe(1);
        expect(resolver.calls).toHaveLength(1);
        expect(fake.executedCommands[0]).not.toContain("{{secret");
        expect(fake.executedCommands[0]).not.toContain("env-");
        expect(Object.keys(fake.commandEnvironments[0]!)).toEqual([
          "BASE",
          "OPENGENI_SECRET_0",
          "OPENGENI_SECRET_1",
        ]);
        await route.clearSecretFilesForAttempt();
        expect(
          [...fake.files.keys()].some((path) =>
            path.startsWith(secretScopeDirectory(secretScopeFor(resolver))),
          ),
        ).toBe(false);
      } finally {
        await session.close();
      }
    },
  );

  test("routed OpenSandbox without native delivery capability remains fail-closed", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    Object.defineProperty(session, "secretExecDeliveryTransport", { value: undefined });
    const backend = { session, sandboxId: "sbx-1", kind: "opensandbox", activeEpoch: 0 };
    const route = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: "sbx-1", activeEpoch: 0 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => "admitted",
      afterMutation: async () => {},
    });
    const resolver = createStaticSecretResolver(
      { Fixture: "synthetic-noncredential-refused-route" },
      { enabled: true },
    );
    const prepared = await prepareSecretExec("cat '{{secretfile:Fixture}}'", {
      resolver,
      dialect: null,
      use: { surface: "shell", toolName: "exec_command" },
    });
    try {
      await expect(
        runWithSecretCarry(prepared!.carry, () =>
          route.execCommand({ cmd: prepared!.text, tty: false }),
        ),
      ).rejects.toMatchObject({ name: "RoutingUnsupportedError" });
      expect(fake.executedCommands).toEqual([]);
      expect(fake.secretFileWrites).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("SDK-owned shell puts ordinary secrets only in the per-command environment", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const value = "synthetic-noncredential-environment-fixture";
    const resolver = createStaticSecretResolver({ Fixture: value }, { enabled: true });
    const prepared = await prepareSecretExec("test -n '{{secret:Fixture}}'", {
      resolver,
      dialect: null,
      use: { surface: "shell", toolName: "exec_command" },
    });
    try {
      await runWithSecretCarry(prepared!.carry, () =>
        session.exec({ cmd: prepared!.text, tty: false }),
      );
      expect(fake.executedCommands[0]).not.toContain("{{secret:");
      expect(fake.executedCommands[0]).not.toContain(value);
      expect(fake.commandEnvironments[0]?.OPENGENI_SECRET_0).toBe(value);
      expect(session.state.environment).toEqual({ BASE: "base" });
      await session.exec({ cmd: "printf ordinary", tty: false });
      expect(fake.commandEnvironments[1]).toEqual({ BASE: "base" });
      expect(JSON.stringify(session.state)).not.toContain(value);
    } finally {
      await session.close();
    }
  });

  test("SDK-owned shell refuses unresolved references before provider dispatch", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const resolver = createStaticSecretResolver({}, { enabled: true });
    const controller = createTurnToolCancellationController(undefined, {
      secretResolver: resolver,
    });
    const capability = shell();
    wrapCapabilityToolsForTurnCancellation(capability as never, controller);
    const tools = capability
      .clone()
      .bind(session as never)
      .tools() as Tool<unknown>[];
    const exec = tools.find(
      (tool): tool is Extract<Tool<unknown>, { type: "function" }> =>
        tool.type === "function" && tool.name === "exec_command",
    )!;
    try {
      const result = await exec.invoke(
        {} as never,
        JSON.stringify({ cmd: "cat '{{secretfile:Missing}}'", tty: false }),
        { toolCall: { callId: "secretfile-refused" } } as never,
      );
      expect(result).toContain("secret_reference_error");
      expect(fake.executedCommands).toEqual([]);
      expect(fake.commandEnvironments).toEqual([]);
      await controller.waitForQuiescence();
      await controller.clearSecretFiles!();
    } finally {
      await session.close();
    }
  });

  test("SDK-owned secretfile partial write fails without dispatch and remains cleanup-owned", async () => {
    const fake = new FakeOpenSandbox();
    fake.secretWriteFailure = new Error("synthetic filesystem write refusal");
    const session = await createClient(fake).create();
    const resolver = createStaticSecretResolver(
      { Fixture: "synthetic-noncredential-partial-fixture" },
      { enabled: true },
    );
    const prepared = await prepareSecretExec("cat '{{secretfile:Fixture}}'", {
      resolver,
      dialect: null,
      use: { surface: "shell", toolName: "exec_command" },
    });
    try {
      await expect(
        runWithSecretCarry(prepared!.carry, () =>
          session.exec({ cmd: prepared!.text, tty: false }),
        ),
      ).rejects.toBe(fake.secretWriteFailure);
      expect(fake.executedCommands).toEqual([]);
      const directory = secretScopeDirectory(secretScopeFor(resolver));
      expect(fake.files.has(directory)).toBe(true);
      await session.clearSecretFilesForAttempt();
      expect([...fake.files.keys()].some((path) => path.startsWith(directory))).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("SDK-owned provider deletion retires only its already-deleted secret scopes", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const resolver = createStaticSecretResolver(
      { Fixture: "synthetic-noncredential-deletion-fixture" },
      { enabled: true },
    );
    const prepared = await prepareSecretExec("cat '{{secretfile:Fixture}}'", {
      resolver,
      dialect: null,
      use: { surface: "shell", toolName: "exec_command" },
    });
    await runWithSecretCarry(prepared!.carry, () =>
      session.exec({ cmd: prepared!.text, tty: false }),
    );
    await session.delete();
    const calls = [...fake.calls];
    await session.clearSecretFilesForAttempt();
    expect(fake.calls).toEqual(calls);
    expect(fake.sandboxExists).toBe(false);
  });

  test("create returns the accepted ID before endpoint, health, or manifest work", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const session = await client.create({
      manifest: new Manifest({
        environment: { TURN: "turn" },
        entries: { "hello.txt": { type: "file", content: "hello" } },
      }),
    });

    expect(session.state).toMatchObject({
      sandboxId: "sbx-1",
      image: IMAGE,
      workspaceReady: false,
      environment: { BASE: "base", TURN: "turn" },
    });
    expect(fake.calls).toEqual(["createSandbox"]);
    expect(fake.lifecycleRequestTimeoutSeconds).toBe(2);
    expect(fake.createdRequest).toMatchObject({
      image: { uri: IMAGE },
      timeout: 60,
      resourceLimits: { cpu: "1", memory: "1Gi" },
      resourceRequests: { cpu: "250m", memory: "512Mi" },
      env: { BASE: "base", TURN: "turn" },
    });
    expect(fake.createdRequest).not.toHaveProperty("secureAccess");

    await session.start();
    expect(session.state.workspaceReady).toBe(true);
    expect(fake.files.get("/workspace")).toEqual({ type: "directory" });
    expect(new TextDecoder().decode(fake.files.get("/workspace/hello.txt")?.data)).toBe("hello");
    expect(fake.calls.indexOf("health:ping")).toBeGreaterThan(fake.calls.indexOf("createSandbox"));
  });

  test("empty manifests still establish the declared workspace root", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();

    await session.start();

    expect(session.state.workspaceReady).toBe(true);
    expect(fake.files.get("/workspace")).toEqual({ type: "directory" });
  });

  test("workspace tar capture allows live sockets and only rejects fifos or devices", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.start();
    fake.files.set("/.opengeni-private/capture-ignored.tar", {
      type: "file",
      data: new Uint8Array([0x1f]),
    });
    await session.persistWorkspaceTar().catch(() => undefined);
    const capture = fake.executedCommands.find((command) => command.includes(" --format=gnu -cf "));
    expect(capture).toBeDefined();
    expect(capture).not.toContain("workspace contains a non-file entry");
    expect(capture).toContain("workspace contains a non-portable fifo or device");
    expect(capture).toContain("-type p");
    expect(capture).not.toContain("! -type f ! -type d");
  });

  test("exec before start still creates the declared workspace root", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();

    const result = await session.exec({ cmd: "printf ready", yieldTimeMs: 30_000 });

    expect(result.exitCode).toBe(0);
    expect(session.state.workspaceReady).toBe(true);
    expect(fake.files.get("/workspace")).toEqual({ type: "directory" });
    expect(fake.calls.indexOf("command:run")).toBeGreaterThan(
      fake.calls.findIndex((call) => call === "createSandbox"),
    );
  });

  test("delete works before start and never resolves endpoints", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.delete();
    expect(fake.calls).toEqual(["createSandbox", "deleteSandbox:sbx-1"]);
  });

  test("exact resume verifies the persisted ID and missing never creates", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const created = await client.create();
    const serialized = await client.serializeSessionState(created.state);
    const state = await client.deserializeSessionState(serialized);

    const resumed = await client.resumeExact(state);
    expect(resumed.state).toBe(state);
    expect(fake.calls.filter((call) => call === "createSandbox")).toHaveLength(1);

    fake.sandboxExists = false;
    await expect(client.resumeExact(state)).rejects.toBeInstanceOf(
      SandboxExactResumeInstanceUnavailableError,
    );
    expect(fake.calls.filter((call) => call === "createSandbox")).toHaveLength(1);
  });

  test("direct exact resume rejects a concrete provider image mismatch", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    fake.reportedImage = `registry.example.com/opengeni@sha256:${"b".repeat(64)}`;

    await expect(session.start()).rejects.toThrow(/image changed for the persisted sandbox/);
  });

  test("pool exact resume accepts opaque lifecycle image and missing pool evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedImage = "unknown";
    const session = await createClient(fake, { poolRef: "warm-pool" }).create();

    expect(fake.createdRequest).toMatchObject({
      extensions: { poolRef: "warm-pool" },
      resourceLimits: { cpu: "1", memory: "1Gi" },
    });
    expect(fake.createdRequest).not.toHaveProperty("image");
    await session.start();
    expect(session.state.workspaceReady).toBe(true);
  });

  test("pool exact resume rejects explicit conflicting provider evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedImage = "unknown";
    fake.reportedExtensions = { poolRef: "other-pool" };
    const session = await createClient(fake, { poolRef: "warm-pool" }).create();

    await expect(session.start()).rejects.toThrow(/pool changed for the persisted sandbox/);
  });

  test("direct exact resume rejects explicit provider pool evidence", async () => {
    const fake = new FakeOpenSandbox();
    fake.reportedExtensions = { poolRef: "unexpected-pool" };
    const session = await createClient(fake).create();

    await expect(session.start()).rejects.toThrow(/pool changed for the persisted sandbox/);
  });

  test("state codec rejects another provider binding", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake);
    const created = await client.create();
    const serialized = await client.serializeSessionState(created.state);
    await expect(
      new OpenSandboxClient({
        baseUrl: "https://other.example.test",
        apiKey: "other",
        image: IMAGE,
        ttlSeconds: 60,
        useServerProxy: true,
        readyTimeoutSeconds: 2,
        resourceLimits: { cpu: "1" },
        resourceRequests: { cpu: "250m" },
        adapterFactory: fake.adapterFactory,
      }).deserializeSessionState(serialized),
    ).rejects.toBeInstanceOf(SandboxConfigError);
  });

  test("a sandbox created before an image or pool change stays usable after the upgrade", async () => {
    const fake = new FakeOpenSandbox();
    const created = await createClient(fake).create();
    const serialized = await createClient(fake).serializeSessionState(created.state);
    const upgradedImage = `registry.example.com/opengeni@sha256:${"c".repeat(64)}`;
    const upgraded = createClient(fake, { image: upgradedImage, poolRef: "new-pool" });

    const state = await upgraded.deserializeSessionState(serialized);
    expect(state.image).toBe(IMAGE);
    expect(state.poolRef).toBeNull();
    const resumed = await upgraded.resumeExact(state);
    // The live sandbox is verified against the image it was created with.
    await resumed.start();
    expect(await upgraded.serializeSessionState(resumed.state)).toMatchObject({
      image: IMAGE,
      poolRef: null,
    });
    await upgraded.delete(state);
    expect(fake.calls).toContain("deleteSandbox:sbx-1");
    expect(fake.calls.filter((call) => call === "createSandbox")).toHaveLength(1);
  });

  test("foreground command preserves ordered output and retained Ctrl-C interrupts exact execution", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const foreground = await session.exec({
      cmd: "printf test",
      yieldTimeMs: 100,
    });
    expect(foreground).toMatchObject({
      output: "outerr",
      stdout: "out",
      stderr: "err",
      exitCode: 0,
    });

    fake.holdCommand();
    const retained = await runWithToolCallCorrelation("tool-call", () =>
      session.exec({ cmd: "sleep 30", yieldTimeMs: 0 }),
    );
    expect(retained.sessionId).toBeNumber();
    expect(session.hasRetainedProcess(retained.sessionId!)).toBe(true);
    expect(await session.cancelExecCommand("tool-call:0")).toBe(true);
    expect(fake.interrupted).toEqual(["exec-1"]);
    const settled = await session.writeStdin({
      sessionId: retained.sessionId!,
      yieldTimeMs: 100,
    });
    expect(settled).toContain("Process exited with code 0");
    expect(session.hasRetainedProcess(retained.sessionId!)).toBe(false);
  });

  test.each([
    [1, 0],
    [10_000, 0],
    [1, 7],
    [10_000, 7],
  ] as const)(
    "yielded provider callback output stays separate at token limit %s and exit %s",
    async (maxOutputTokens, exitCode) => {
      const fake = heldOutputProvider(exitCode);
      const session = await createClient(fake).create();
      const started = deferred();
      const exec = session.exec.bind(session);
      const read = session.writeStdin.bind(session);
      let handle: number | undefined;
      let reads = 0;
      session.exec = async (args) => {
        const raw = await exec(args);
        handle = raw.sessionId;
        started.resolve();
        return raw;
      };
      session.writeStdin = async (args) => {
        expect(args.sessionId).toBe(handle);
        expect(args.chars).toBe("");
        expect(args.maxOutputTokens).toBe(maxOutputTokens);
        reads++;
        return await read(args);
      };
      const completion = executeSynchronousCommand(session, {
        cmd: "filesystem command once",
        yieldTimeMs: 1,
        maxOutputTokens,
        login: false,
      }).catch((error: unknown) => error);
      try {
        await started.promise;
        expect(handle).toBeNumber();
        fake.resolveCommand?.();
        const result = await completion;
        expect(result).not.toBeInstanceOf(Error);
        expect(result).toMatchObject({
          stdout: `prefix${"x".repeat(2_000)}`,
          stderr: "y".repeat(2_000),
          exitCode,
        });
        expect(reads).toBe(1);
        expect(fake.executedCommands).toEqual(["filesystem command once"]);
        expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);
        expect(session.hasRetainedProcess(handle!)).toBe(false);
      } finally {
        fake.resolveCommand?.();
        await session.close();
      }
    },
  );

  test.each([
    [1, 0],
    [10_000, 0],
    [1, 7],
    [10_000, 7],
  ] as const)(
    "public SDK stream completion preserves separate output at token limit %s and exit %s",
    async (maxOutputTokens, exitCode) => {
      const fake = new FakeOpenSandbox();
      const release = deferred();
      const encoder = new TextEncoder();
      let starts = 0;
      const streamFetch = (async (input, init) => {
        expect(String(input)).toEndWith("/command");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body)).command).toBe("streamed original");
        starts++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const event = (value: Record<string, unknown>) =>
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ timestamp: Date.now(), ...value })}\n\n`,
                  ),
                );
              event({ type: "init", text: "exec-stream" });
              event({ type: "stdout", text: "prefix" });
              void release.promise.then(() => {
                event({ type: "stdout", text: "x".repeat(2_000) });
                event({ type: "stderr", text: "y".repeat(2_000) });
                if (exitCode !== 0)
                  event({
                    type: "error",
                    error: {
                      ename: "CommandExecutionError",
                      evalue: String(exitCode),
                      traceback: [],
                    },
                  });
                event({ type: "execution_complete", execution_time: 1 });
                controller.close();
              });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch;
      const originalStack = fake.adapterFactory.createExecdStack.bind(fake.adapterFactory);
      fake.adapterFactory.createExecdStack = (options) => ({
        ...originalStack(options),
        commands: new DefaultAdapterFactory().createExecdStack({
          ...options,
          connectionConfig: new Proxy(options.connectionConfig, {
            get(target, property, receiver) {
              return property === "fetch" || property === "sseFetch"
                ? streamFetch
                : Reflect.get(target, property, receiver);
            },
          }),
        }).commands,
      });
      const session = await createClient(fake).create();
      try {
        const initial = await session.exec({
          cmd: "streamed original",
          yieldTimeMs: 1,
          maxOutputTokens,
          login: false,
        });
        const first = synchronousCommandPage(session, initial);
        expect(first).toMatchObject({ stdout: "prefix", stderr: "", sessionId: 1, exitCode: null });
        release.resolve();
        let reads = 0;
        const result = await observeSynchronousCommand(first, async (sessionId) => {
          expect(sessionId).toBe(initial.sessionId!);
          reads++;
          const banner = await session.writeStdin({
            sessionId,
            chars: "",
            yieldTimeMs: 1_000,
            maxOutputTokens,
          });
          expect(banner).toContain(`Process exited with code ${exitCode}`);
          const page = synchronousCommandPage(session, banner, sessionId);
          expect(page.collectionUnavailable).toBeUndefined();
          expect(page.outputCursor).toMatchObject({
            identity: first.outputCursor!.identity,
            expected: { stdout: 6, stderr: 0 },
            next: { stdout: 2_006, stderr: 2_000 },
          });
          if (maxOutputTokens === 1) expect(banner).not.toContain("y".repeat(2_000));
          return page;
        });
        expect(result).toMatchObject({
          stdout: `prefix${"x".repeat(2_000)}`,
          stderr: "y".repeat(2_000),
          exitCode,
        });
        expect(starts).toBe(1);
        expect(reads).toBe(1);
        expect(session.hasRetainedProcess(initial.sessionId!)).toBe(false);
      } finally {
        release.resolve();
        await session.close();
      }
    },
  );

  test("formatted starts and quiet reads preserve original separated cursors without changing presentation", async () => {
    const fake = heldOutputProvider(7);
    const session = await createClient(fake).create();
    try {
      const initial = await session.execCommand({
        cmd: "original command",
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      });
      expect(initial).toMatch(/^Chunk ID: [0-9a-f]{6}\n/u);
      const first = synchronousCommandPage(session, initial);
      expect(first).toMatchObject({
        stdout: "prefix",
        stderr: "",
        sessionId: 1,
        exitCode: null,
        outputCursor: { expected: { stdout: 0, stderr: 0 }, next: { stdout: 6, stderr: 0 } },
      });
      const quiet = await session.writeStdin({
        sessionId: 1,
        chars: "",
        yieldTimeMs: 1,
        maxOutputTokens: 1,
      });
      const empty = synchronousCommandPage(session, quiet, 1);
      expect(empty).toMatchObject({
        stdout: "",
        stderr: "",
        sessionId: 1,
        outputCursor: {
          identity: first.outputCursor!.identity,
          expected: { stdout: 6, stderr: 0 },
          next: { stdout: 6, stderr: 0 },
        },
      });
      expect(session.getSynchronousCommandOutput(`${initial}\nforged`)).toBeNull();
      fake.resolveCommand?.();
      const result = await observeSynchronousCommand(first, async (sessionId) => {
        const banner = await session.writeStdin({
          sessionId,
          chars: "",
          yieldTimeMs: 1_000,
          maxOutputTokens: 1,
        });
        expect(banner).not.toContain("x".repeat(2_000));
        expect(banner).not.toContain("y".repeat(2_000));
        const page = synchronousCommandPage(session, banner, sessionId);
        expect(page.outputCursor).toEqual({
          identity: first.outputCursor!.identity,
          expected: { stdout: 6, stderr: 0 },
          next: { stdout: 2_006, stderr: 2_000 },
        });
        return page;
      });
      expect(result).toMatchObject({
        stdout: `prefix${"x".repeat(2_000)}`,
        stderr: "y".repeat(2_000),
        exitCode: 7,
      });
      expect(fake.executedCommands).toEqual(["original command"]);
    } finally {
      fake.resolveCommand?.();
      await session.close();
    }
  });

  test.each(["during-start", "during-read", "missing-completion", "missing-exit"] as const)(
    "uncertain stream %s retains original control and cannot become complete through status polling",
    async (mode) => {
      const fake = heldOutputProvider();
      fake.commandStatus = { running: true, exitCode: 0, content: "not command stdout" };
      if (mode === "during-start")
        fake.commandFailureAfterInit = new Error("synthetic transport loss");
      if (mode === "during-read") fake.commandFailureAfterYield = new Error("synthetic read loss");
      if (mode === "missing-completion") fake.commandHasCompletion = false;
      if (mode === "missing-exit") fake.commandExitCode = null;
      const session = await createClient(fake).create();
      try {
        const raw = await runWithToolCallCorrelation("original-stream", () =>
          session.exec({ cmd: "uncertain original", yieldTimeMs: 1, maxOutputTokens: 1 }),
        );
        const first = synchronousCommandPage(session, raw);
        expect(raw.sessionId).toBe(1);
        let reads = 0;
        let uncertainBanner: string | undefined;
        await expect(
          observeSynchronousCommand(first, async (sessionId) => {
            reads++;
            expect(sessionId).toBe(1);
            const pending = session.writeStdinForProcessControl({
              sessionId,
              chars: "",
              yieldTimeMs: 1_000,
              maxOutputTokens: 1,
            });
            fake.resolveCommand?.();
            uncertainBanner = await pending;
            return synchronousCommandPage(session, uncertainBanner, sessionId);
          }),
        ).rejects.toMatchObject({
          code: "synchronous_command_outcome_unknown",
          sessionId: 1,
          output: { stdout: "prefix", stderr: "" },
        });
        expect(reads).toBe(mode === "during-start" ? 0 : 1);
        expect(session.hasRetainedProcess(1)).toBe(true);
        uncertainBanner ??= await session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
          yieldTimeMs: 1,
        });
        const partial = session.getSynchronousCommandOutput(uncertainBanner)!;
        expect(partial).toMatchObject({
          collectionUnavailable: true,
          sessionId: 1,
          exitCode: null,
        });
        expect(partial.stderr).toBe(
          mode === "missing-completion" || mode === "missing-exit" ? "y".repeat(2_000) : "",
        );
        await session.acknowledgeCommandOutput(uncertainBanner);
        expect(session.getSynchronousCommandOutput(uncertainBanner)).toBe(partial);
        expect(await session.cancelExecCommand("original-stream:0")).toBe(true);
        expect(fake.interrupted).toEqual(["exec-1"]);
        fake.commandStatus = {
          running: false,
          exitCode: null,
          content: "not command stdout",
          error: "synthetic status diagnostic",
        };
        const malformedStatus = await session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
          yieldTimeMs: 1,
        });
        expect(malformedStatus).toContain("synthetic status diagnostic");
        expect(session.getSynchronousCommandOutput(malformedStatus)).toMatchObject({
          stdout: "",
          stderr: "",
          sessionId: 1,
          exitCode: null,
          collectionUnavailable: true,
        });
        expect(session.hasRetainedProcess(1)).toBe(true);
        fake.commandStatus = { running: false, exitCode: 7, content: "not command stdout" };
        const terminal = await session.writeStdinForProcessControl({
          sessionId: 1,
          chars: "",
          yieldTimeMs: 1,
        });
        expect(terminal).toContain("Process exited with code 7");
        expect(terminal).not.toContain("not command stdout");
        const statusOnly = session.getSynchronousCommandOutput(terminal)!;
        expect(statusOnly).toMatchObject({
          stdout: "",
          stderr: "",
          exitCode: 7,
          collectionUnavailable: true,
        });
        expect(statusOnly.sessionId).toBeUndefined();
        expect(statusOnly.outputCursor!.identity).toBe(first.outputCursor!.identity);
        await session.acknowledgeCommandOutput(terminal);
        expect(session.getSynchronousCommandOutput(terminal)).toBe(statusOnly);
        expect(session.hasRetainedProcess(1)).toBe(false);
        await expect(
          observeSynchronousCommand(first, async () => statusOnly),
        ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
        expect(fake.executedCommands).toEqual(["uncertain original"]);
      } finally {
        fake.resolveCommand?.();
        await session.close();
      }
    },
  );

  test.each(["none", "capture", "settlement"] as const)(
    "shared terminal readers preserve actual adapter pages across %s retry and acknowledgement",
    async (failure) => {
      const fake = heldOutputProvider(7);
      const session = await createClient(fake).create();
      const backend = { session, sandboxId: "sbx-1", kind: "opensandbox", activeEpoch: 0 };
      const initialCaptured = deferred();
      const beginRead = deferred();
      const synchronousReadEntered = deferred();
      const externalReadEntered = deferred();
      const releaseRead = deferred();
      const write = session.writeStdin.bind(session);
      let reads = 0;
      let providerBanner: string | undefined;
      let failed = false;
      let settlements = 0;
      const durable = new Map<string, { stream: "stdout" | "stderr"; chunk: string }>();
      session.writeStdin = async (args) => {
        reads++;
        expect(args.sessionId).toBe(1);
        externalReadEntered.resolve();
        await releaseRead.promise;
        return (providerBanner = await write(args));
      };
      const route = new RoutingSandboxSession({
        defaultResolved: backend,
        readPointer: async () => ({ activeSandboxId: "sbx-1", activeEpoch: 0 }),
        resolveActiveBackend: async () => backend,
        beforeMutation: async () => "admitted",
        afterMutation: async () => {},
        captureProcessOutput: async (page) => {
          expect(page.streamFidelity).toBe("separate");
          if (page.chunk !== "prefix")
            expect(session.getSynchronousCommandOutput(providerBanner)).not.toBeNull();
          durable.set(page.chunkId, page);
          if (failure === "capture" && !failed && page.chunk !== "prefix") {
            failed = true;
            throw new Error("lost capture reply");
          }
        },
        settleProcess: async ({ proof }) => {
          expect(proof.exitCode).toBe(7);
          if (failure === "settlement" && !failed) {
            failed = true;
            throw new Error("settlement unavailable");
          }
          settlements++;
        },
      });
      const completion = route.execSynchronous(
        { cmd: "shared original", yieldTimeMs: 1, maxOutputTokens: 1 },
        async (adapter, args) => {
          const exec = adapter.exec!.bind(adapter);
          adapter.exec = async (input) => {
            const raw = await exec(input);
            initialCaptured.resolve();
            await beginRead.promise;
            return raw;
          };
          const read = adapter.writeStdinForProcessControl!.bind(adapter);
          adapter.writeStdinForProcessControl = (input) => {
            const pending = read(input);
            synchronousReadEntered.resolve();
            return pending;
          };
          return await executeSynchronousCommand(adapter, args);
        },
      );
      try {
        await initialCaptured.promise;
        const external = route
          .writeStdinForProcessControl({ sessionId: 1, chars: "", maxOutputTokens: 1 })
          .catch((error: unknown) => error);
        await externalReadEntered.promise;
        beginRead.resolve();
        await synchronousReadEntered.promise;
        fake.resolveCommand?.();
        releaseRead.resolve();
        const externalResult = await external;
        if (failure === "none") expect(externalResult).toBeString();
        else expect(externalResult).toBeInstanceOf(RoutingMutationOutcomeUnknownError);
        const result = await completion;
        expect(result).toMatchObject({
          stdout: `prefix${"x".repeat(2_000)}`,
          stderr: "y".repeat(2_000),
          exitCode: 7,
        });
        expect(session.getSynchronousCommandOutput(providerBanner)).toBeNull();
        expect(reads).toBe(1);
        expect(settlements).toBe(1);
        expect(route.hasRetainedProcess(1)).toBe(false);
        expect(durable.size).toBe(3);
        for (const stream of ["stdout", "stderr"] as const)
          expect(
            [...durable.values()]
              .filter((page) => page.stream === stream)
              .map((page) => page.chunk)
              .join(""),
          ).toBe(result[stream]);
        expect(fake.executedCommands).toEqual(["shared original"]);
      } finally {
        beginRead.resolve();
        releaseRead.resolve();
        fake.resolveCommand?.();
        await session.close();
      }
    },
  );

  test("physical status settlement after stream loss cannot authorize a complete filesystem result", async () => {
    const fake = heldOutputProvider();
    fake.commandFailureAfterYield = new Error("synthetic read loss");
    const session = await createClient(fake).create();
    const backend = { session, sandboxId: "sbx-1", kind: "opensandbox", activeEpoch: 0 };
    const readEntered = deferred();
    const write = session.writeStdin.bind(session);
    const captured: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    let settlements = 0;
    session.writeStdin = (args) => {
      const pending = write(args);
      readEntered.resolve();
      return pending;
    };
    const route = new RoutingSandboxSession({
      defaultResolved: backend,
      readPointer: async () => ({ activeSandboxId: "sbx-1", activeEpoch: 0 }),
      resolveActiveBackend: async () => backend,
      beforeMutation: async () => "admitted",
      afterMutation: async () => {},
      captureProcessOutput: async (page) => {
        expect(page.streamFidelity).toBe("separate");
        captured.push(page);
      },
      settleProcess: async ({ proof }) => {
        expect(proof.exitCode).toBe(7);
        settlements++;
      },
    });
    try {
      const completion = route
        .execSynchronous({ cmd: "uncertain original", yieldTimeMs: 1, maxOutputTokens: 1 })
        .catch((error: unknown) => error);
      await readEntered.promise;
      fake.resolveCommand?.();
      const error = await completion;
      expect(error).toMatchObject({
        code: "synchronous_command_outcome_unknown",
        sessionId: 1,
        output: { stdout: "prefix", stderr: "" },
      });
      expect(route.hasRetainedProcess(1)).toBe(true);
      expect(settlements).toBe(0);
      fake.commandStatus = { running: false, exitCode: 7, content: "not stdout" };
      const terminal = await route.writeStdinForProcessControl({
        sessionId: 1,
        chars: "",
        yieldTimeMs: 1,
      });
      const page = session.getSynchronousCommandOutput(terminal)!;
      expect(page).toMatchObject({ exitCode: 7, collectionUnavailable: true });
      await expect(
        observeSynchronousCommand(page, async () => {
          throw new Error("must not replay");
        }),
      ).rejects.toMatchObject({ code: "synchronous_command_outcome_unknown" });
      expect(route.hasRetainedProcess(1)).toBe(false);
      expect(settlements).toBe(1);
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({ stream: "stdout", chunk: "prefix" });
      expect(fake.executedCommands).toEqual(["uncertain original"]);
    } finally {
      fake.resolveCommand?.();
      await session.close();
    }
  });

  test("does not expose interactive write_stdin while retaining internal poll and interrupt control", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    const tools = shell()
      .clone()
      .bind(session as never)
      .tools();

    expect(session.supportsPty()).toBe(false);
    expect(tools.map((tool) => tool.name)).toContain("exec_command");
    expect(tools.map((tool) => tool.name)).not.toContain("write_stdin");
    expect(typeof session.writeStdinForProcessControl).toBe("function");
  });

  test("post-dispatch transport loss polls status without exposing provider command content", async () => {
    const fake = new FakeOpenSandbox();
    fake.commandFailureAfterInit = new Error("synthetic transport loss");
    fake.commandStatus = {
      running: true,
      exitCode: 0,
      content: "long-task",
    };
    const session = await createClient(fake).create();

    const retained = await runWithToolCallCorrelation("tool-call", () =>
      session.exec({ cmd: "long-task", yieldTimeMs: 100 }),
    );
    expect(retained.output).toBe("outerrsynthetic transport loss\n");
    expect(retained.sessionId).toBeNumber();
    const sessionId = retained.sessionId!;
    expect(retained.exitCode).toBeUndefined();
    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);

    const running = await session.writeStdin({ sessionId, yieldTimeMs: 1 });
    expect(running).not.toContain("long-task");
    expect(running).toContain(`Process running with session ID ${sessionId}`);

    fake.commandStatus = {
      running: false,
      exitCode: 17,
      content: "long-task",
      error: "provider command failed",
    };
    const settled = await session.writeStdin({ sessionId, yieldTimeMs: 1 });
    expect(settled).not.toContain("long-task");
    expect(settled).toContain("provider command failed");
    expect(settled).toContain("Process exited with code 17");
    expect(session.hasRetainedProcess(sessionId)).toBe(false);
    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);
  });

  test("filesystem absence is typed only while the exact provider exists", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.listDir({ path: "." });
    fake.filesystemReadError = new SandboxApiException({ message: "missing", statusCode: 404 });
    for (const read of [
      () => session.listDir({ path: ".agents/skills" }),
      () => session.readFile({ path: "SKILL.md" }),
    ]) {
      await expect(read()).rejects.toMatchObject({ name: "SandboxWorkspaceReadNotFoundError" });
    }
    fake.sandboxExists = false;
    await expect(session.listDir({ path: ".agents/skills" })).rejects.toBeInstanceOf(
      SandboxApiException,
    );
    await expect(session.readFile({ path: "SKILL.md" })).rejects.toBeInstanceOf(
      SandboxApiException,
    );
  });

  test("files and ports stay inside the declared workspace/private roots", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create();
    await session.writeFile({ path: "dir/value.txt", content: "value" });
    expect(
      new TextDecoder().decode(await session.readFile({ path: "/workspace/dir/value.txt" })),
    ).toBe("value");
    expect(await session.pathExists("dir/value.txt")).toBe(true);
    expect(await session.listDir({ path: "dir" })).toEqual([
      { name: "value.txt", path: "dir/value.txt", type: "file" },
    ]);
    await expect(session.readFile({ path: "/etc/passwd" })).rejects.toThrow(/must stay within/);
    await expect(
      session.writeFile({
        path: "/tmp/opengeni-browserd/authority/admin-token",
        content: "token\n",
      }),
    ).resolves.toBe(6);
    await expect(session.exec({ cmd: "id", runAs: "root" })).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );

    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint).toMatchObject({
      host: "opensandbox.example.test",
      port: 443,
      tls: true,
      path: "/sandboxes/sbx-1/8080",
      headers: { "x-open-sandbox-route": "sbx-1" },
    });
  });

  test("server-proxy endpoints rewrite cluster hosts to the configured lifecycle base URL", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake, {
      baseUrl: "http://127.0.0.1:18090",
    }).create();
    const endpoint = await session.resolveExposedPort(6080);
    expect(endpoint).toMatchObject({
      host: "127.0.0.1",
      port: 18090,
      tls: false,
      path: "/sandboxes/sbx-1/6080/vnc.html",
      protocol: "http",
    });
    expect(endpoint.url).toBe("http://127.0.0.1:18090/sandboxes/sbx-1/6080/vnc.html");
  });

  test("signed endpoints keep the provider-advertised host when server proxy is off", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake, { useServerProxy: false }).create();
    const endpoint = await session.resolveExposedPort(8080);
    expect(endpoint).toMatchObject({
      host: "proxy.example.test",
      port: 443,
      tls: true,
      path: "/sandboxes/sbx-1/8080",
    });
  });

  test("signed Channel B mints OSEP URIs without vnc.html and rewrites the public base", async () => {
    const fake = new FakeOpenSandbox();
    const client = createClient(fake, {
      signedEndpoints: true,
      signedEndpointTtlSeconds: 600,
      channelBPublicBaseUrl: "http://127.0.0.1:28888",
      useServerProxy: true,
    });
    const session = await client.create();
    expect(session.requireHostFetchController).toBe(true);
    expect(fake.createdRequest).toMatchObject({ secureAccess: true });
    const endpoint = await session.resolveExposedPort(6080);
    expect(fake.calls.some((call) => call.startsWith("getSignedEndpoint:sbx-1:6080:"))).toBe(true);
    expect(fake.calls.some((call) => call.startsWith("getSandboxEndpoint:"))).toBe(false);
    expect(endpoint).toMatchObject({
      host: "127.0.0.1",
      port: 28888,
      tls: false,
    });
    expect(endpoint.path).toMatch(/^\/sbx-1\/6080\/[0-9a-z]+\/sigsigsig$/);
    expect(endpoint.path).not.toContain("vnc.html");
    const persisted = await client.serializeSessionState(session.state);
    expect(persisted.exposedPorts).toBeUndefined();
  });

  test("signed Channel B keeps the advertised ingress host without a public-base rewrite", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake, { signedEndpoints: true }).create();
    const endpoint = await session.resolveExposedPort(6080);
    expect(endpoint).toMatchObject({
      host: "ingress.example.test",
      port: 443,
      tls: true,
    });
    expect(endpoint.path).toMatch(/^\/sbx-1\/6080\/[0-9a-z]+\/sigsigsig$/);
    expect(endpoint.path).not.toContain("vnc.html");
  });

  test("signed Channel B fails closed when GetSignedEndpoint fails", async () => {
    const fake = new FakeOpenSandbox();
    fake.signedEndpointError = new Error("signed mint failed");
    const session = await createClient(fake, { signedEndpoints: true }).create();
    await expect(session.resolveExposedPort(7682)).rejects.toThrow("signed mint failed");
    expect(fake.calls.some((call) => call.startsWith("getSandboxEndpoint:"))).toBe(false);
  });

  test("archive input bound rejects bytes before upload or command execution", async () => {
    const fake = new FakeOpenSandbox();
    const session = await createClient(fake).create({
      archiveLimits: { maxInputBytes: 3 },
    });
    await expect(session.hydrateWorkspace(new Uint8Array([1, 2, 3, 4]))).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );
    expect(fake.calls).toEqual(["createSandbox"]);
  });

  test("archive restore keeps cleanup paths until its internal command is terminal", async () => {
    const fake = new FakeOpenSandbox();
    fake.holdCommand();
    const session = await createClient(fake).create();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: () => void, timeout?: number) =>
      originalSetTimeout(handler, timeout === 120_000 ? 0 : timeout)) as typeof setTimeout;
    let settled = false;
    let failure: unknown;

    try {
      const hydration = session.hydrateWorkspace(new Uint8Array([1, 2, 3])).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          failure = error;
        },
      );
      await Bun.sleep(20);

      expect(fake.calls).toContain("command:run");
      expect(settled).toBe(false);
      expect(
        [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
      ).toHaveLength(1);

      fake.resolveCommand?.();
      await hydration;

      expect(failure).toBeUndefined();
      expect(settled).toBe(true);
      expect(
        [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
      ).toHaveLength(0);
    } finally {
      fake.resolveCommand?.();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test("archive restore polls an exact uncertain execution before cleanup", async () => {
    const fake = new FakeOpenSandbox();
    fake.commandFailureAfterInit = new Error("synthetic restore transport loss");
    fake.commandStatus = {
      running: false,
      exitCode: 17,
      content: "provider command content must stay private",
      error: "provider restore failed",
    };
    const session = await createClient(fake).create();

    await expect(session.hydrateWorkspace(new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      SandboxArchiveError,
    );

    expect(fake.calls.filter((call) => call === "command:run")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "command:status:exec-1")).toHaveLength(1);
    expect(
      [...fake.files.keys()].filter((path) => path.startsWith("/tmp/opengeni-private/restore-")),
    ).toHaveLength(0);
  });

  test("archive restore replaces a non-root workspace without writing its parent", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "opengeni-osb-restore-"));
    const readonlyParent = join(temporary, "readonly-parent");
    const workspace = join(readonlyParent, "workspace");
    const source = join(temporary, "source");
    const archive = join(temporary, "workspace.tar");
    const staging = join(workspace, ".opengeni-restore-test");
    const backup = join(workspace, ".opengeni-old-test");
    const runningAsRoot = process.getuid?.() === 0;
    const targetUid = runningAsRoot ? 65_534 : process.getuid?.();
    const targetGid = runningAsRoot ? 65_534 : process.getgid?.();

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(source, { recursive: true });
      await writeFile(join(workspace, "old.txt"), "old");
      await writeFile(join(source, "new.txt"), "new");
      const packed = spawnSync("tar", ["-cf", archive, "-C", source, "."], {
        encoding: "utf8",
      });
      expect(packed.status).toBe(0);

      if (runningAsRoot) {
        await chown(workspace, targetUid!, targetGid!);
      }
      await chmod(temporary, 0o555);
      await chmod(readonlyParent, 0o555);
      await chmod(workspace, 0o755);
      await chmod(archive, 0o444);

      const options: SpawnSyncOptions = { encoding: "utf8" };
      if (runningAsRoot) {
        options.uid = targetUid;
        options.gid = targetGid;
      }
      const restored = spawnSync(
        "python3",
        ["-c", archiveRestoreScript(), archive, workspace, staging, backup, "-1", "-1", ""],
        options,
      );

      expect(restored.status, restored.stderr?.toString()).toBe(0);
      expect(await readFile(join(workspace, "new.txt"), "utf8")).toBe("new");
      await expect(readFile(join(workspace, "old.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(staging, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(backup, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await chmod(temporary, 0o755).catch(() => undefined);
      await chmod(readonlyParent, 0o755).catch(() => undefined);
      await chmod(workspace, 0o755).catch(() => undefined);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});

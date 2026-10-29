import { expect, test } from "bun:test";
import { Manifest, type SandboxClient, type SandboxSessionLike } from "@openai/agents/sandbox";
import { withSandboxSessionReady } from "../src/index";
import { createTurnToolCancellationController } from "../src/sandbox/turn-tool-cancellation";

async function cleanupThroughInstalledSdk(session: SandboxSessionLike): Promise<void> {
  // Exercise the installed SDK's real stop/delete ordering, not a copied cleanup loop.
  const lifecycle: unknown = await import(new URL(
    "./sandbox/runtime/sessionLifecycle.mjs",
    import.meta.resolve("@openai/agents-core"),
  ).href);
  if (typeof lifecycle !== "object" || lifecycle === null ||
      !("cleanupSandboxSession" in lifecycle) || typeof lifecycle.cleanupSandboxSession !== "function") {
    throw new Error("Installed SDK sandbox cleanup contract unavailable");
  }
  await lifecycle.cleanupSandboxSession(session);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const operation of ["create", "resume"] as const) {
  for (const lifecycle of ["stop", "shutdown", "delete", "close"] as const) {
    test(`SDK-owned ${operation} ${lifecycle} retains provider until turn writers are quiescent`, async () => {
      const calls: string[] = [];
      const drained = deferred();
      const session: SandboxSessionLike = {
        state: { manifest: new Manifest() },
        [lifecycle]: async function () {
          expect(this).toBe(session);
          calls.push("destroy");
        },
      };
      const client: SandboxClient = {
        backendId: "opensandbox",
        create: async () => session,
        resume: async () => session,
      };
      const wrapped = withSandboxSessionReady(client, () => { calls.push("ready"); }, {
        cancel: () => { calls.push("cancel"); },
        waitForQuiescence: async () => { calls.push("drain"); await drained.promise; },
      });
      const selected = operation === "create"
        ? await wrapped.create!({ manifest: session.state.manifest })
        : await wrapped.resume!(session.state);
      const destruction = selected[lifecycle]!();
      await Promise.resolve();
      expect(calls).toEqual(["ready", "cancel", "drain"]);
      drained.resolve();
      await destruction;
      expect(calls).toEqual(["ready", "cancel", "drain", "destroy"]);
    });
  }
}

test("failed quiescence never destroys provider or claims successful command output", async () => {
  const failure = new Error("exact physical outcome unknown");
  const calls: string[] = [];
  const session: SandboxSessionLike = {
    state: { manifest: new Manifest() },
    delete: async () => { calls.push("destroy"); },
  };
  const wrapped = withSandboxSessionReady({ backendId: "opensandbox", create: async () => session }, () => {}, {
    cancel: () => {},
    waitForQuiescence: async () => { throw failure; },
  });
  await wrapped.create!({ manifest: session.state.manifest });
  await expect(session.delete!()).rejects.toBe(failure);
  expect(calls).toEqual([]);
});

for (const fault of ["command404 while sandbox lives", "401", "500", "network unavailable"]) {
  test(`real SDK cleanup retains provider while exact command proof is unknown: ${fault}`, async () => {
    const controller = createTurnToolCancellationController();
    const started = deferred();
    const cancelled = deferred();
    let providerAlive = true;
    let physicalExit = false;
    let controlAvailable = false;
    let cancellationAttempts = 0;
    const session = {
      state: { manifest: new Manifest() },
      supportsPty: () => false,
      exec: async () => {
        started.resolve();
        await cancelled.promise;
        return { exitCode: 130, output: "cancelled", stdout: "", stderr: "", wallTimeSeconds: 0 };
      },
      cancelExecCommand: async () => {
        expect(providerAlive).toBe(true);
        cancellationAttempts++;
        if (!controlAvailable) throw new Error(fault);
        physicalExit = true;
        cancelled.resolve();
        return true;
      },
      observeExecCommand: async () => {
        if (!controlAvailable) throw new Error(fault);
        return physicalExit
          ? { status: "completed" as const, result: { exitCode: 130 } }
          : { status: "running" as const };
      },
      delete: async () => { providerAlive = false; },
    };
    const wrapped = withSandboxSessionReady(
      { backendId: "opensandbox", create: async () => session }, () => {}, controller,
    );
    await wrapped.create!({ manifest: session.state.manifest });
    const command = controller.runSandboxCommand(session, { cmd: "sleep 45" });
    const rejected = command.then(() => ({ resolved: true as const }), (error: unknown) => ({ resolved: false as const, error }));
    await started.promise;
    const cleanup = cleanupThroughInstalledSdk(session);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (cancellationAttempts !== 0) break;
      await Bun.sleep(2);
    }
    expect(cancellationAttempts).toBeGreaterThan(0);
    expect(providerAlive).toBe(true);
    expect(physicalExit).toBe(false);
    controlAvailable = true;
    await cleanup;
    const outcome = await rejected;
    expect(outcome.resolved).toBe(false);
    if (!outcome.resolved) {
      expect(outcome.error).toBeInstanceOf(Error);
      if (outcome.error instanceof Error) expect(outcome.error.message).toBe("SDK_OWNED_SANDBOX_CLEANUP");
    }
    expect(physicalExit).toBe(true);
    expect(providerAlive).toBe(false);
  });
}

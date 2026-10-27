import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  HOST_LIFECYCLE_HOOK_FAILED,
  awaitHostLifecycleHook,
  signOutAfterHostHook,
  switchWorkspaceAfterHostHook,
} from "./host-lifecycle";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const errors = spyOn(console, "error").mockImplementation(() => undefined);
afterEach(() => errors.mockClear());

describe("host lifecycle hooks", () => {
  test("sign-out waits for the host hook, then signs out", async () => {
    const order: string[] = [];
    const hook = deferred();
    const done = signOutAfterHostHook(
      {
        onSignOut: () => {
          order.push("hook");
          return hook.promise;
        },
      },
      async () => {
        order.push("sign-out");
        return "signed out";
      },
    );
    await flush();
    expect(order).toEqual(["hook"]);
    hook.resolve();
    expect(await done).toBe("signed out");
    expect(order).toEqual(["hook", "sign-out"]);
    expect(errors).not.toHaveBeenCalled();
  });

  test("a hook that rejects still signs out, and logs HOST_LIFECYCLE_HOOK_FAILED", async () => {
    let signedOut = false;
    await signOutAfterHostHook(
      { onSignOut: async () => Promise.reject(new Error("host down")) },
      async () => {
        signedOut = true;
      },
    );
    expect(signedOut).toBe(true);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]?.[0]).toBe(HOST_LIFECYCLE_HOOK_FAILED);
    expect(errors.mock.calls[0]?.[1]).toMatchObject({ hook: "onSignOut", reason: "rejected" });
  });

  test("a hook that never settles is abandoned after the timeout", async () => {
    let ran = false;
    await awaitHostLifecycleHook("onSignOut", () => new Promise<void>(() => undefined), 10).then(
      () => {
        ran = true;
      },
    );
    expect(ran).toBe(true);
    expect(errors.mock.calls[0]?.[1]).toMatchObject({ hook: "onSignOut", reason: "timeout" });
  });

  test("a hook that throws synchronously is contained", async () => {
    await awaitHostLifecycleHook("onWorkspaceSwitch", () => {
      throw new Error("sync");
    });
    expect(errors.mock.calls[0]?.[1]).toMatchObject({
      hook: "onWorkspaceSwitch",
      reason: "rejected",
    });
  });

  test("switching waits for onWorkspaceSwitch(from, to) before going on", async () => {
    const seen: string[] = [];
    const hook = deferred();
    switchWorkspaceAfterHostHook(
      {
        onWorkspaceSwitch: (from, to) => {
          seen.push(`${from}->${to}`);
          return hook.promise;
        },
      },
      "w1",
      "w2",
      () => seen.push("navigate"),
    );
    await flush();
    expect(seen).toEqual(["w1->w2"]);
    hook.resolve();
    await flush();
    expect(seen).toEqual(["w1->w2", "navigate"]);
  });

  test("without a hook, or staying in the same workspace, it goes on at once", () => {
    const seen: string[] = [];
    switchWorkspaceAfterHostHook(undefined, "w1", "w2", () => seen.push("no hook"));
    switchWorkspaceAfterHostHook(
      {
        onWorkspaceSwitch: async () => {
          seen.push("hook");
        },
      },
      "w1",
      "w1",
      () => seen.push("same workspace"),
    );
    expect(seen).toEqual(["no hook", "same workspace"]);
  });
});

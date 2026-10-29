import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
async function implementation() {
  expect(existsSync(new URL("./host-command-providers.tsx", import.meta.url))).toBe(true);
  return import("./host-command-providers");
}
const context = { workspaceId: "w1", pathname: "/workspaces/w1/sessions" };
test("host command paths stay internal and resolve relative to their workspace", async () => {
  const { hostCommandHref } = await implementation();
  expect(hostCommandHref("records/42?view=details", "w1")).toBe("/workspaces/w1/records/42?view=details");
  expect(hostCommandHref("/register", "w1")).toBe("/register");
  expect(hostCommandHref("/a/../register?x=1#tab", "w1")).toBe("/register?x=1#tab");
  expect(hostCommandHref("../records/42", "w1")).toBe("/workspaces/records/42");
  for (const path of ["https://outside.test/", "javascript:alert(1)", "//outside.test", "/.//outside.test", "/a/..//outside.test", "/%2e//outside.test", "/a/%2e%2e//outside.test", "a\\b", "a\nb"]) expect(hostCommandHref(path, "w1")).toBeUndefined();
});
test("provider rejection, timeout and malformed results preserve other provider results", async () => {
  const { createHostCommandMenuSearch } = await implementation();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  let timedSignal: AbortSignal | undefined;
  const search = createHostCommandMenuSearch([
    { id: "reject", heading: "Reject", search: async () => { throw new Error("private host error"); } },
    { id: "timeout", heading: "Timeout", search: async (_q, _c, signal) => { timedSignal = signal; return new Promise<never>(() => undefined); } },
    { id: "unsafe", heading: "Unsafe", search: async () => [{ id: "x", label: "Unsafe", path: "https://outside.test" }] },
    { id: "good", heading: "Records", search: async () => [{ id: "r", label: "Record", path: "records/42" }] },
  ]);
  try {
    expect(await search("record", context, new AbortController().signal)).toEqual([{ id: "good", heading: "Records", items: [{ id: "r", label: "Record", path: "/workspaces/w1/records/42" }] }]);
    expect(timedSignal?.aborted).toBe(true);
    expect(warning.mock.calls).toEqual([["HOST_COMMAND_PROVIDER_FAILED"]]);
  } finally { warning.mockRestore(); }
});
test("caller cancellation aborts the host search without a failure warning", async () => {
  const { createHostCommandMenuSearch } = await implementation();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  let started: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let observed: AbortSignal | undefined;
  const search = createHostCommandMenuSearch([{ id: "host", heading: "Host", search: async (_q, _c, signal) => { observed = signal; started(); return new Promise<never>(() => undefined); } }]);
  const controller = new AbortController();
  try {
    const result = search("record", context, controller.signal);
    await ready;
    controller.abort();
    expect(await result).toEqual([]);
    expect(observed?.aborted).toBe(true);
    expect(warning).not.toHaveBeenCalled();
  } finally { warning.mockRestore(); }
});

test("cancellation before the scheduled callback never invokes host code", async () => {
  const { createHostCommandMenuSearch } = await implementation();
  let calls = 0;
  const search = createHostCommandMenuSearch([{ id: "host", heading: "Host", search: async () => { calls += 1; return []; } }]);
  const controller = new AbortController();
  const result = search("record", context, controller.signal);
  controller.abort();
  expect(await result).toEqual([]);
  expect(calls).toBe(0);
});
test("an invalid command entry is dropped while valid entries from that provider remain", async () => {
  const { createHostCommandMenuSearch } = await implementation();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const search = createHostCommandMenuSearch([{ id: "host", heading: "Host", search: async () => [
    { id: "good", label: "Good", path: "records/42" },
    { id: "bad", label: "Bad", path: "https://outside.test" },
  ] }]);
  try {
    expect(await search("record", context, new AbortController().signal)).toEqual([{ id: "host", heading: "Host", items: [{ id: "good", label: "Good", path: "/workspaces/w1/records/42" }] }]);
    expect(warning.mock.calls).toEqual([["HOST_COMMAND_PROVIDER_FAILED"]]);
  } finally { warning.mockRestore(); }
});

test("the same installed provider set warns once across search instances", async () => {
  const { createHostCommandMenuSearch } = await implementation();
  const warning = spyOn(console, "warn").mockImplementation(() => undefined);
  const providers = [{ id: "host", heading: "Host", search: async () => { throw new Error("host unavailable"); } }];
  try {
    await createHostCommandMenuSearch(providers)("one", context, new AbortController().signal);
    await createHostCommandMenuSearch(providers)("two", context, new AbortController().signal);
    expect(warning.mock.calls).toEqual([["HOST_COMMAND_PROVIDER_FAILED"]]);
  } finally { warning.mockRestore(); }
});

test("normalized dot segments remain internal and never traverse above the application root", async () => {
  const { hostCommandHref } = await implementation();
  expect(hostCommandHref("/./x", "w1")).toBe("/x");
  expect(hostCommandHref("/a/../x", "w1")).toBe("/x");
  expect(hostCommandHref("/a/%2E%2e/x", "w1")).toBe("/x");
  expect(hostCommandHref("../../x", "w1")).toBe("/x");
  for (const path of ["/a/../../x", "/%2e%2e/", "/a/.%2e/%2e./x", "../../../x", "//x", "/\\x"]) {
    expect(hostCommandHref(path, "w1")).toBeUndefined();
  }
});

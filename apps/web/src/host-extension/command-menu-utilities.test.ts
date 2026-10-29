import { expect, test } from "bun:test";
import { validateHostExtension } from "./registry";

const Icon = () => null;
const utility = (id: string) => ({ id, label: id, icon: Icon, load: async () => ({ default: Icon }) });
test("host provider and utility metadata is checked without calling host code", () => {
  let calls = 0;
  validateHostExtension({ id: "host", commandMenuProviders: [{ id: "records", heading: "Records", search: () => { calls += 1; throw new Error("not at install"); } }], utilities: [{ ...utility("notifications"), load: () => { calls += 1; throw new Error("not at install"); } }] });
  expect(calls).toBe(0);
});
test("malformed command provider metadata is refused at install by name", () => {
  const provider = { id: "records", heading: "Records", search: async () => [] };
  for (const commandMenuProviders of [42, [{ ...provider, heading: "" }], [{ ...provider, search: 42 }], [{ ...provider, extra: true }], [provider, provider]]) {
    expect(() => validateHostExtension({ id: "host", commandMenuProviders })).toThrow("commandMenuProviders");
  }
});
test("host utilities are limited to three and malformed metadata is refused", () => {
  for (const utilities of [[utility("a"), utility("b"), utility("c"), utility("d")], [{ ...utility("a"), load: 42 }], [{ ...utility("a"), icon: "invalid" }], [utility("a"), utility("a")]]) {
    expect(() => validateHostExtension({ id: "host", utilities })).toThrow("utilities");
  }
});

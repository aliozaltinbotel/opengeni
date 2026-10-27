import { expect, test } from "bun:test";
import type { ClientConfig } from "@opengeni/sdk";
import {
  startWorkspaceVoiceCapabilityRefresh,
  workspaceScopedClientConfig,
} from "./workspace-voice-capability";
const config = (available: boolean) =>
  ({ voiceInput: { available, providers: [] } }) as unknown as ClientConfig;

test("workspace change retires old readiness even when the old read ignores abort", async () => {
  let resolve!: (value: ClientConfig) => void;
  const writes: unknown[] = [];
  const dispose = startWorkspaceVoiceCapabilityRefresh({
    read: () => new Promise((r) => (resolve = r)),
    ownsWorkspace: () => true,
    apply: (v) => writes.push(v),
    subscribeFocus: () => () => {},
  });
  dispose();
  resolve(config(true));
  await Promise.resolve();
  expect(writes).toEqual([]);
});

test("focus retries readiness and a stale principal cannot repopulate it", async () => {
  let owns = true,
    focus!: () => void;
  const writes: unknown[] = [];
  const pending: ((value: ClientConfig) => void)[] = [];
  const dispose = startWorkspaceVoiceCapabilityRefresh({
    read: () => new Promise((r) => pending.push(r)),
    ownsWorkspace: () => owns,
    apply: (v) => writes.push(v),
    subscribeFocus: (f) => {
      focus = f;
      return () => {};
    },
  });
  pending.shift()!(config(false));
  await Promise.resolve();
  focus();
  pending.shift()!(config(true));
  await Promise.resolve();
  expect(writes).toEqual([config(false).voiceInput, config(true).voiceInput]);
  focus();
  owns = false;
  pending.shift()!(config(true));
  await Promise.resolve();
  expect(writes).toHaveLength(2);
  dispose();
});

test("the workspace read also applies the workspace's attachment availability", async () => {
  const fileUploads: unknown[] = [];
  const dispose = startWorkspaceVoiceCapabilityRefresh({
    read: async () =>
      ({
        voiceInput: { available: true, providers: [] },
        fileUploads: { enabled: false, maxSizeBytes: 5_000 },
      }) as unknown as ClientConfig,
    ownsWorkspace: () => true,
    apply: () => {},
    applyFileUploads: (value) => fileUploads.push(value),
    subscribeFocus: () => () => {},
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(fileUploads).toEqual([{ enabled: false, maxSizeBytes: 5_000 }]);
  dispose();
});

test("a workspace whose organization turns attachments off hides the attach affordance", () => {
  const deployment = {
    voiceInput: { available: true, providers: ["a"] },
    fileUploads: { enabled: true, maxSizeBytes: 10_000 },
  } as unknown as ClientConfig;
  // Before the workspace read: the deployment's uploads, voice unavailable.
  expect(workspaceScopedClientConfig(deployment, {}).fileUploads.enabled).toBe(true);
  expect(workspaceScopedClientConfig(deployment, {}).voiceInput?.available).toBe(false);
  const governed = workspaceScopedClientConfig(deployment, {
    fileUploads: { enabled: false, maxSizeBytes: 10_000 },
    voiceInput: { available: true, providers: ["a"] } as unknown as ClientConfig["voiceInput"],
  });
  // Every composer reads `clientConfig.fileUploads.enabled` to show attach.
  expect(governed.fileUploads.enabled).toBe(false);
  expect(governed.voiceInput?.available).toBe(true);
});

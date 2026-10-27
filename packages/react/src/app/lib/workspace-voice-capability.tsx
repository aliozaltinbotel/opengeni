import type { ClientConfig } from "@opengeni/sdk";

/** Retire old workspace reads before they can update the shared composer. */
export function startWorkspaceVoiceCapabilityRefresh(input: {
  read(signal: AbortSignal): Promise<ClientConfig>;
  ownsWorkspace(): boolean;
  apply(voiceInput: ClientConfig["voiceInput"]): void;
  /** The workspace's attachment availability: its organization may turn uploads off. */
  applyFileUploads?(fileUploads: ClientConfig["fileUploads"]): void;
  subscribeFocus(refresh: () => void): () => void;
}): () => void {
  let request: AbortController | null = null;
  let disposed = false;
  const refresh = () => {
    if (disposed || !input.ownsWorkspace()) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    void input
      .read(controller.signal)
      .then((config) => {
        if (controller.signal.aborted || !input.ownsWorkspace()) return;
        input.apply(config.voiceInput);
        input.applyFileUploads?.(config.fileUploads);
      })
      .catch(() => {
        // Keep unavailable state after a transition; focus retries transient reads.
      });
  };
  refresh();
  const unsubscribe = input.subscribeFocus(refresh);
  return () => {
    disposed = true;
    request?.abort();
    unsubscribe();
  };
}

/**
 * The app's client config for the current workspace. Voice stays unavailable
 * until the workspace read answers; uploads follow the deployment until then,
 * and the workspace's answer (its organization may turn them off) after.
 */
export function workspaceScopedClientConfig(
  clientConfig: ClientConfig,
  workspace: {
    voiceInput?: ClientConfig["voiceInput"] | undefined;
    fileUploads?: ClientConfig["fileUploads"] | undefined;
  },
): ClientConfig {
  return {
    ...clientConfig,
    voiceInput:
      workspace.voiceInput ??
      (clientConfig.voiceInput
        ? { ...clientConfig.voiceInput, available: false, providers: [] }
        : undefined),
    fileUploads: workspace.fileUploads ?? clientConfig.fileUploads,
  };
}

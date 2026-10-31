// The chat side panel's state (`HostExtension.chatPanel`), kept beside the
// page frames rather than in one of them: a rail page that opens it and the
// next one show the same chat. Loaded with the first extension rail page.
import type { HostExtensionChatPanel } from "@opengeni/react/app/host-extension";
import type { MessageContextItem } from "@opengeni/react/app/lib/message-context";

/**
 * The extension's `chatPanel` and the console's message-context check, handed
 * to the page frame by routes.tsx (the frame imports no startup module).
 */
export type ChatPanelSeam = Readonly<{
  panel: HostExtensionChatPanel;
  /** `validateHostMessageContext`: throws for a value `messageContext` may not return. */
  validate: (value: unknown) => void;
}>;

export type ChatPanelState = Readonly<{
  workspaceId: string | null;
  open: boolean;
  /** The chat in the panel; null while a new one is composed. */
  sessionId: string | null;
  /** What the page last opened the panel with, checked. */
  context: readonly MessageContextItem[];
  /** Counts opens, so the panel focuses its composer on each. */
  openCount: number;
}>;

const CLOSED: ChatPanelState = {
  workspaceId: null,
  open: false,
  sessionId: null,
  context: [],
  openCount: 0,
};

let state = CLOSED;
const listeners = new Set<() => void>();
let reported = false;

function update(next: ChatPanelState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function chatPanelState(): ChatPanelState {
  return state;
}

export function subscribeToChatPanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The page's context as items, through the same check as the extension's
 * `messageContext` (labelled items with unique ids). A refused value opens
 * the panel without it and warns once.
 */
export function checkedChatPanelContext(
  validate: ChatPanelSeam["validate"],
  value: unknown,
): readonly MessageContextItem[] {
  try {
    validate(value);
  } catch {
    if (!reported) {
      reported = true;
      console.warn("HOST_CHAT_PANEL_CONTEXT_FAILED");
    }
    return [];
  }
  const items = (
    value === undefined ? [] : Array.isArray(value) ? value : [value]
  ) as readonly MessageContextItem[];
  return items.map(({ id, text, label, detail }) => ({
    id,
    text,
    label,
    ...(detail === undefined ? {} : { detail }),
  }));
}

/**
 * Shows the panel in `workspaceId` with `value` for the next messages. A chat
 * open there keeps going; a closed panel (or another workspace's) starts a
 * new one.
 */
export function openChatPanelIn(
  validate: ChatPanelSeam["validate"],
  workspaceId: string,
  value: unknown,
): void {
  const keep = state.open && state.workspaceId === workspaceId;
  update({
    workspaceId,
    open: true,
    sessionId: keep ? state.sessionId : null,
    context: checkedChatPanelContext(validate, value),
    openCount: state.openCount + 1,
  });
}

export function showChatPanelSession(sessionId: string | null): void {
  update({ ...state, sessionId });
}

export function closeChatPanel(): void {
  update({ ...state, open: false });
}

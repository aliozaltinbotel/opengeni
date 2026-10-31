// The host API for the console's chat side panel (`HostExtension.chatPanel`).
// A host page calls `openChatPanel(context)`; the console, beside each rail page
// its `chatPanel.enabled` answers true for, holds the one opener that shows the
// person's own chat there.
//
// Startup code never imports this module: the console reaches it from the lazy
// host page frame and the extension from its own lazy pages, so it adds nothing
// to the startup load.
import type { MessageContextInput } from "./lib/message-context";

export type ChatPanelOpener = (context: MessageContextInput) => boolean;

let opener: ChatPanelOpener | null = null;

/**
 * Opens the console's chat beside the host page in view, with `context` sent
 * with the next message: labelled items, checked like the extension's
 * `messageContext`, shown as pills the person can leave out. A chat already
 * open in the panel stays open and takes the new context. Returns false, and
 * changes nothing, when no panel is offered here: the stock console, a page
 * `chatPanel.enabled` answers false for, or a settings page.
 */
export function openChatPanel(context: MessageContextInput): boolean {
  return opener ? opener(context) : false;
}

/**
 * The console's side: installs the opener for the page in view and returns
 * its removal, which leaves a newer opener in place.
 */
export function setChatPanelOpener(next: ChatPanelOpener): () => void {
  opener = next;
  return () => {
    if (opener === next) opener = null;
  };
}

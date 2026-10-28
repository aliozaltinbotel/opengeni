import { useRouterState } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useKnowledgeReviewIndicator } from "./use-knowledge-review-indicator";
import { useScheduledTaskAttentionIndicator } from "./use-scheduled-task-attention";
import { useMeetingRecorderState } from "@opengeni/react/meetings";
import { InboxLink } from "@/components/rail/inbox-link";
import { useRail } from "@opengeni/react/app/components/rail/rail-context";
import { WorkspaceConfigLink } from "@/components/rail/workspace-config-link";
import {
  HostExtensionNavLink,
  isHostExtensionNavItemActive,
} from "@/components/rail/host-extension-nav-link";
import {
  isConfigItemActive,
  PRIMARY_WORKSPACE_ITEMS,
  type WorkspaceConfigItem,
  type WorkspaceConfigTarget,
} from "@/components/rail/workspace-nav-data";
import { currentHostExtension } from "@/host-extension/registry";
import {
  composePrimaryNav,
  type HostExtensionNavItem,
  type NativeNavId,
} from "@opengeni/react/app/host-extension";
import { Button } from "@opengeni/react/ui/button";
import { cn } from "@opengeni/react/app/lib/utils";

const WORKSPACE_SHORTCUTS_EXPANDED_KEY = "opengeni.rail.nav";

/** A native rail entry: the inbox, or a workspace shortcut with its destination item. */
type NativeRailEntry =
  | Readonly<{ id: "inbox"; label: string }>
  | Readonly<{ id: Exclude<NativeNavId, "inbox">; label: string; item: WorkspaceConfigItem }>;
type ShortcutEntry = Extract<NativeRailEntry, { item: WorkspaceConfigItem }>;
type RailEntry = NativeRailEntry | HostExtensionNavItem;

/** The native rail entries in rail order: the inbox, then the shortcuts. */
const NATIVE_RAIL_ENTRIES: readonly NativeRailEntry[] = [
  { id: "inbox", label: "Inbox" },
  ...PRIMARY_WORKSPACE_ITEMS.map(
    (item): NativeRailEntry => ({
      id: item.to.split("/").at(-1) as Exclude<NativeNavId, "inbox">,
      label: item.label,
      item,
    }),
  ),
];

function isHostEntry(entry: RailEntry): entry is HostExtensionNavItem {
  return "placement" in entry;
}

function isShortcut(entry: RailEntry): entry is ShortcutEntry {
  return !isHostEntry(entry) && entry.id !== "inbox";
}

/** A shortcut's destination item under its (possibly overridden) label. */
function shortcutItem(entry: ShortcutEntry): WorkspaceConfigItem {
  return entry.label === entry.item.label ? entry.item : { ...entry.item, label: entry.label };
}

/**
 * The rail the host extension composes (read at render, after startup):
 * hidden destinations left out, overrides applied, then its primary items.
 */
function composedRail(workspaceId: string, pathname: string) {
  const { chat, peers } = composePrimaryNav(currentHostExtension(), NATIVE_RAIL_ENTRIES, {
    workspaceId,
    pathname,
  });
  const inbox = peers.find((entry) => !isHostEntry(entry) && entry.id === "inbox");
  return {
    chat,
    inbox: inbox && !isHostEntry(inbox) ? inbox : undefined,
    shortcuts: peers.filter((entry) => isHostEntry(entry) || entry.id !== "inbox"),
  };
}

/** A peer shortcut, or undefined when the extension hides it or moves it off the peers. */
function peerShortcut(
  shortcuts: readonly RailEntry[],
  to: WorkspaceConfigTarget,
): WorkspaceConfigItem | undefined {
  const entry = shortcuts.find((candidate) => isShortcut(candidate) && candidate.item.to === to);
  return entry && isShortcut(entry) ? shortcutItem(entry) : undefined;
}

function initialWorkspaceShortcutsExpanded(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY);
    return raw === "true";
  } catch {
    return true;
  }
}

export function WorkspaceShortcutLinks({
  className,
  pending,
  scheduleAttention,
}: {
  className?: string;
  pending?: boolean;
  scheduleAttention?: boolean;
}) {
  const rail = useRail();
  const fetchedPending = useKnowledgeReviewIndicator(rail.workspaceId, pending === undefined);
  const pendingKnowledge = pending ?? fetchedPending;
  const fetchedAttention = useScheduledTaskAttentionIndicator(
    rail.workspaceId,
    scheduleAttention === undefined,
  );
  const schedulesNeedAttention = scheduleAttention ?? fetchedAttention;
  const recorderState = useMeetingRecorderState();
  const recording = recorderState === "recording" || recorderState === "paused";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { shortcuts } = composedRail(rail.workspaceId, pathname);

  return (
    <div className={cn("grid gap-0.5", className)}>
      {shortcuts.map((entry) => (
        <RailEntryLink
          key={isHostEntry(entry) ? `host:${entry.id}` : entry.id}
          entry={entry}
          pathname={pathname}
          pendingKnowledge={pendingKnowledge}
          schedulesNeedAttention={schedulesNeedAttention}
          recording={recording}
        />
      ))}
    </div>
  );
}

/** One rail row: the inbox, a native shortcut (with its indicator) or a host entry. */
function RailEntryLink({
  entry,
  pathname,
  pendingKnowledge = false,
  schedulesNeedAttention = false,
  recording = false,
}: {
  entry: RailEntry;
  pathname: string;
  pendingKnowledge?: boolean;
  schedulesNeedAttention?: boolean;
  recording?: boolean;
}) {
  const rail = useRail();
  if (isHostEntry(entry))
    return (
      <HostExtensionNavLink
        item={entry}
        workspaceId={rail.workspaceId}
        variant="rail"
        collapsed={rail.collapsed}
        active={isHostExtensionNavItemActive(pathname, rail.workspaceId, entry)}
        onNavigate={() => rail.setDrawerOpen(false)}
      />
    );
  if (!isShortcut(entry)) return <InboxLink label={entry.label} />;
  const item = shortcutItem(entry);
  return (
    <WorkspaceConfigLink
      item={item}
      needsReview={item.to === "/workspaces/$workspaceId/state" && pendingKnowledge}
      needsAttention={item.to === "/workspaces/$workspaceId/automations" && schedulesNeedAttention}
      recording={item.to === "/workspaces/$workspaceId/meetings" && recording}
      workspaceId={rail.workspaceId}
      variant="rail"
      collapsed={rail.collapsed}
      active={isConfigItemActive(pathname, rail.workspaceId, item.to)}
      onNavigate={() => rail.setDrawerOpen(false)}
    />
  );
}

/**
 * The chat utility group: the native entries the host extension moved next
 * to "New session", drawn as their own group with a rule under it.
 */
function ChatUtilityGroup({
  entries,
  ...indicators
}: {
  entries: readonly NativeRailEntry[];
  pathname: string;
  pendingKnowledge: boolean;
  schedulesNeedAttention: boolean;
  recording: boolean;
}) {
  return (
    <>
      <div role="group" aria-label="Chat" data-rail-group="chat" className="grid gap-0.5">
        {entries.map((entry) => (
          <RailEntryLink key={entry.id} entry={entry} {...indicators} />
        ))}
      </div>
      <div
        role="separator"
        data-rail-group-separator=""
        className="mx-2.5 my-1.5 border-t border-border"
      />
    </>
  );
}

/**
 * The web app's primary navigation after the shared "New session" link: the
 * inbox and the workspace shortcuts, kept separate from workspace administration.
 */
export function PrimaryNavExtras() {
  const rail = useRail();
  const pendingKnowledge = useKnowledgeReviewIndicator(rail.workspaceId);
  const schedulesNeedAttention = useScheduledTaskAttentionIndicator(rail.workspaceId);
  const recorderState = useMeetingRecorderState();
  const recordingMeeting = recorderState === "recording" || recorderState === "paused";
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { chat, inbox, shortcuts } = composedRail(rail.workspaceId, pathname);
  const knowledgeItem = peerShortcut(shortcuts, "/workspaces/$workspaceId/state");
  const automationsItem = peerShortcut(shortcuts, "/workspaces/$workspaceId/automations");
  const meetingsItem = peerShortcut(shortcuts, "/workspaces/$workspaceId/meetings");
  const activeWorkspaceSection = shortcuts.find((entry) =>
    isHostEntry(entry)
      ? isHostExtensionNavItemActive(pathname, rail.workspaceId, entry)
      : isShortcut(entry) && isConfigItemActive(pathname, rail.workspaceId, entry.item.to),
  )?.label;
  const [shortcutsExpanded, setShortcutsExpandedState] = useState(
    initialWorkspaceShortcutsExpanded,
  );
  const [shortViewport, setShortViewport] = useState(
    () => typeof window !== "undefined" && window.innerHeight < 720,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-height: 719px)");
    const update = () => setShortViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  const showShortcuts = !shortViewport || shortcutsExpanded;
  const setShortcutsExpanded = (next: boolean) => {
    setShortcutsExpandedState(next);
    try {
      window.localStorage.setItem(WORKSPACE_SHORTCUTS_EXPANDED_KEY, String(next));
    } catch {
      // Keep the in-memory choice when storage is unavailable.
    }
  };

  return (
    <>
      {chat.length > 0 ? (
        <ChatUtilityGroup
          entries={chat}
          pathname={pathname}
          pendingKnowledge={pendingKnowledge}
          schedulesNeedAttention={schedulesNeedAttention}
          recording={recordingMeeting}
        />
      ) : null}
      {inbox ? <InboxLink label={inbox.label} /> : null}

      {rail.isMobile ? null : rail.collapsed ? (
        <WorkspaceShortcutLinks
          pending={pendingKnowledge}
          scheduleAttention={schedulesNeedAttention}
        />
      ) : (
        <div className="grid gap-0.5">
          {showShortcuts ? (
            <>
              <WorkspaceShortcutLinks
                pending={pendingKnowledge}
                scheduleAttention={schedulesNeedAttention}
              />
              {shortViewport ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded="true"
                  onClick={() => setShortcutsExpanded(false)}
                  className="h-6 w-full justify-start gap-1.5 px-2.5 text-2xs font-normal text-fg-muted hover:text-fg"
                >
                  <ChevronDownIcon aria-hidden="true" className="size-3 rotate-180" />
                  Less
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {pendingKnowledge && knowledgeItem ? (
                <WorkspaceConfigLink
                  item={knowledgeItem}
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  needsReview
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/state",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              {schedulesNeedAttention && automationsItem ? (
                <WorkspaceConfigLink
                  item={automationsItem}
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  needsAttention
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/automations",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              {recordingMeeting && meetingsItem ? (
                <WorkspaceConfigLink
                  item={meetingsItem}
                  workspaceId={rail.workspaceId}
                  variant="rail"
                  recording
                  active={isConfigItemActive(
                    pathname,
                    rail.workspaceId,
                    "/workspaces/$workspaceId/meetings",
                  )}
                  onNavigate={() => rail.setDrawerOpen(false)}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-expanded="false"
                aria-label={
                  activeWorkspaceSection
                    ? `More, current section ${activeWorkspaceSection}`
                    : undefined
                }
                data-active={activeWorkspaceSection ? "true" : undefined}
                onClick={() => setShortcutsExpanded(true)}
                className={cn(
                  "group relative w-full justify-start gap-2.5 px-2.5 font-normal text-fg-label pointer-coarse:h-10",
                  activeWorkspaceSection && "bg-selection text-fg hover:bg-selection",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand transition-opacity",
                    activeWorkspaceSection ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-left">More</span>
                <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0" />
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}

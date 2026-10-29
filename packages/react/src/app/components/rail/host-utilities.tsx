import { CircleIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import { Popover } from "radix-ui";
import type { HostExtensionUtility } from "../../host-extension";
import { useAppHost } from "../../lib/app-host";
import { cn } from "../../lib/utils";
import { Button } from "../../../ui/button";
import { MENU_SURFACE_CLASS } from "../../../ui/menu-styles";
import { containedPortal } from "../../../ui/portal-container";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../../ui/tooltip";
import { FailureRecoveryBoundary } from "../session/failure-recovery-boundary";

const PopoverContainedPortal = containedPortal(Popover.Portal);
const reportedUtilitySets = new WeakSet<readonly HostExtensionUtility[]>();

function reportFailure(utilities: readonly HostExtensionUtility[]): void {
  if (reportedUtilitySets.has(utilities)) return;
  reportedUtilitySets.add(utilities);
  console.warn("HOST_UTILITY_FAILED");
}

async function loadUtility(utility: HostExtensionUtility) {
  try {
    const loaded = await utility.load();
    const module: unknown = loaded;
    if (typeof module !== "object" || module === null || !("default" in module)) {
      throw new Error("HOST_UTILITY_FAILED");
    }
    const component = module.default;
    if (typeof component !== "function" && !(typeof component === "object" && component !== null && "$$typeof" in component)) {
      throw new Error("HOST_UTILITY_FAILED");
    }
    return loaded;
  } catch {
    // Never forward a rejected host value to React diagnostics.
    throw new Error("HOST_UTILITY_FAILED");
  }
}

function HostRailUtility({ utility, workspaceId, onError }: {
  utility: HostExtensionUtility;
  workspaceId: string;
  onError: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const body = useMemo(() => ({ attempt, Component: lazy(() => loadUtility(utility)) }), [utility, attempt]);
  const Icon = utility.icon;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <Button type="button" variant="ghost" size="icon" aria-label={utility.label}>
              <FailureRecoveryBoundary hostDiagnostics fallback={<CircleIcon className="size-4" aria-hidden="true" />} onError={onError}>
                <Icon className="size-4" />
              </FailureRecoveryBoundary>
            </Button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent side="right">{utility.label}</TooltipContent>
      </Tooltip>
      <PopoverContainedPortal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={utility.label}
          className={cn(MENU_SURFACE_CLASS, "z-50 max-h-[var(--radix-popover-content-available-height)] w-[min(22rem,calc(100vw-2rem))] overflow-y-auto p-3 outline-hidden")}
        >
          {open ? (
            <FailureRecoveryBoundary
              hostDiagnostics
              key={body.attempt}
              onError={onError}
              fallback={
                <div className="flex items-center gap-3">
                  <p role="alert" className="text-sm">Couldn't open {utility.label}.</p>
                  <Button type="button" size="sm" aria-label={`Retry ${utility.label}`} onClick={() => setAttempt((current) => current + 1)}>Retry</Button>
                </div>
              }
            >
              <Suspense fallback={<p role="status" className="text-sm">Loading…</p>}>
                <body.Component workspaceId={workspaceId} />
              </Suspense>
            </FailureRecoveryBoundary>
          ) : null}
        </Popover.Content>
      </PopoverContainedPortal>
    </Popover.Root>
  );
}

/** Host bodies occupy native popovers; the rail always owns their triggers. */
export function HostRailUtilities({ workspaceId, collapsed }: { workspaceId: string; collapsed: boolean }) {
  const utilities = useAppHost().utilities;
  if (!utilities?.length) return null;
  return (
    <TooltipProvider>
      <div data-rail-utilities className={cn("relative z-10 flex shrink-0 gap-1 border-t border-border p-2", collapsed && "flex-col items-center")}>
        {utilities.slice(0, 3).map((utility) => (
          <HostRailUtility key={`${workspaceId}:${utility.id}`} utility={utility} workspaceId={workspaceId} onError={() => reportFailure(utilities)} />
        ))}
      </div>
    </TooltipProvider>
  );
}

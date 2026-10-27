// The workspace's meeting recorder, with the console's routes for where a
// desktop call notification's choice opens. When the host extension hides
// Meetings, a choice opens nothing.
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { MeetingRecorderProvider } from "@opengeni/react/meetings";
import { hiddenNativeDestinations } from "@/host-extension/registry";

export function ConsoleMeetingRecorderProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const meetingsVisible = !hiddenNativeDestinations().includes("meetings");
  return (
    <MeetingRecorderProvider
      workspaceId={workspaceId}
      onOpenMeetings={
        meetingsVisible
          ? () =>
              void navigate({ to: "/workspaces/$workspaceId/meetings", params: { workspaceId } })
          : undefined
      }
      onOpenMeeting={
        meetingsVisible
          ? (recordingId) =>
              void navigate({
                to: "/workspaces/$workspaceId/meetings/$recordingId",
                params: { workspaceId, recordingId },
              })
          : undefined
      }
    >
      {children}
    </MeetingRecorderProvider>
  );
}

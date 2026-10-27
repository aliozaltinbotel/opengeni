// The workspace's meeting recorder, with the console's routes for where a
// desktop call notification's choice opens. When the host extension hides
// Meetings, a choice opens nothing.
import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";

import { MeetingRecorderProvider } from "@opengeni/react/meetings";
import { HIDDEN_NATIVE_DESTINATIONS } from "@/host-extension/registry";

const MEETINGS_VISIBLE = !HIDDEN_NATIVE_DESTINATIONS.includes("meetings");

export function ConsoleMeetingRecorderProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <MeetingRecorderProvider
      workspaceId={workspaceId}
      onOpenMeetings={
        MEETINGS_VISIBLE
          ? () =>
              void navigate({ to: "/workspaces/$workspaceId/meetings", params: { workspaceId } })
          : undefined
      }
      onOpenMeeting={
        MEETINGS_VISIBLE
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

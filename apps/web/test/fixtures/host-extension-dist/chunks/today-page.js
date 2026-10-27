// The fixture's lazy workspace page.
import { jsx, jsxs } from "react/jsx-runtime";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@opengeni/react/ui/card";

export default function TodayPage({ workspaceId }) {
  return jsxs(Card, {
    "data-testid": "fixture-dist-page",
    children: [
      jsx(CardHeader, { children: jsx(CardTitle, { children: "Today" }) }),
      jsx(CardContent, {
        children: jsx(Link, {
          to: "/workspaces/$workspaceId/sessions",
          params: { workspaceId },
          children: "Open chats",
        }),
      }),
    ],
  });
}

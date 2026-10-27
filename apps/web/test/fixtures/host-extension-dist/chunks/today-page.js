// The fixture's lazy workspace page.
import { jsx, jsxs } from "react/jsx-runtime";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@opengeni/react/ui/card";

// The fixture budget build stages a copy that sets a utility class no console
// source uses, to check that Tailwind scans the extension
// (scripts/web-bundle-budget-policy.test.ts). Here it stays unset, because
// Tailwind scans the committed fixture as console source.
const pageClassName = undefined;

export default function TodayPage({ workspaceId }) {
  return jsxs(Card, {
    className: pageClassName,
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

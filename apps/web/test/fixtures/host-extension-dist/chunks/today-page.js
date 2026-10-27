// The fixture's lazy workspace page.
import { jsx, jsxs } from "react/jsx-runtime";
import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@opengeni/react/ui/card";
// The console's direct chat route also loads this icon module, so the fixture
// build checks that a module shared with the startup graph stays there and
// pulls none of the page into it. A real extension bundles its own icons.
import { PencilIcon } from "lucide-react";

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
      jsx(CardHeader, {
        children: jsxs(CardTitle, { children: [jsx(PencilIcon, { "aria-hidden": true }), "Today"] }),
      }),
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

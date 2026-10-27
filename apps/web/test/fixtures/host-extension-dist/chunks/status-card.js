// The fixture's lazy tool card body, rendered for one exact tool name.
import { jsx, jsxs } from "react/jsx-runtime";
import { Badge } from "@opengeni/react/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@opengeni/react/ui/card";

export default function StatusCardBody({ item }) {
  const status =
    item.output && typeof item.output === "object" && typeof item.output.status === "string"
      ? item.output.status
      : "pending";
  return jsxs(Card, {
    "data-testid": "fixture-dist-card",
    children: [
      jsx(CardHeader, { children: jsx(CardTitle, { children: "Onboarding status" }) }),
      jsx(CardContent, { children: jsx(Badge, { variant: "secondary", children: status }) }),
    ],
  });
}

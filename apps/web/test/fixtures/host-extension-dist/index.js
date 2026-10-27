// A prebuilt host extension, shaped like an external lib-mode bundle: ESM with
// bare specifiers for the libraries the console shares (React, the router,
// @opengeni/react), and its eager descriptor kept tiny. The page and the tool
// card body load behind import(). Used by the bundle-budget fixture build and
// by registry.test.ts.
import { jsx } from "react/jsx-runtime";
import { Suspense, lazy } from "react";

const StatusCardBody = lazy(() => import("./chunks/status-card.js"));

function StatusCard(props) {
  return jsx(Suspense, { fallback: null, children: jsx(StatusCardBody, props) });
}

function FixtureIcon({ className }) {
  return jsx("svg", {
    className,
    viewBox: "0 0 16 16",
    "aria-hidden": true,
    children: jsx("circle", { cx: 8, cy: 8, r: 6, fill: "currentColor" }),
  });
}

export default {
  id: "fixture-dist",
  productName: "Fixture",
  routes: [{ path: "fixture-today", load: () => import("./chunks/today-page.js") }],
  nav: [
    {
      id: "fixture-today",
      label: "Today",
      icon: FixtureIcon,
      path: "fixture-today",
      placement: "primary",
    },
  ],
  toolRegistryEntries: [
    {
      match: "name",
      name: "host-app__get_onboarding_status",
      render: StatusCard,
      matchPrefixedLeaf: false,
    },
  ],
};

// A host extension for tests: one rail page and one settings-mode page, each
// with a nav item, the rail page's in the primary nav and the settings page's
// in its own settings group. Each page renders the workspace it was given, so
// a test can see the route passed `workspaceId` through.
import { createElement } from "react";
import type {
  HostExtension,
  HostExtensionPage,
  HostExtensionRoute,
} from "@opengeni/react/app/host-extension";

const FixturePage: HostExtensionPage = ({ workspaceId }) =>
  createElement("p", { "data-testid": "fixture-page" }, `Fixture page for ${workspaceId}`);

const load: HostExtensionRoute["load"] = async () => ({ default: FixturePage });

const FixtureIcon = ({ className }: { className?: string }) =>
  createElement("svg", { className, "data-testid": "fixture-icon" });

export const hostExtensionFixture: HostExtension = {
  id: "fixture",
  productName: "Fixture",
  routes: [
    { path: "pms", load },
    { path: "pms-settings", load, mode: "settings" },
  ],
  nav: [
    {
      id: "today",
      label: "Today",
      description: "What needs doing today",
      icon: FixtureIcon,
      path: "pms",
      placement: "primary",
    },
    {
      id: "property-preferences",
      label: "Property preferences",
      icon: FixtureIcon,
      path: "pms-settings",
      placement: { settingsGroup: "property" },
    },
  ],
  settingsGroups: [{ id: "property", label: "Property" }],
};

export default hostExtensionFixture;

// A host extension for tests: one rail page and one settings-mode page. Each
// page renders the workspace it was given, so a test can see the route passed
// `workspaceId` through.
import { createElement } from "react";
import type {
  HostExtension,
  HostExtensionPage,
  HostExtensionRoute,
} from "@opengeni/react/app/host-extension";

const FixturePage: HostExtensionPage = ({ workspaceId }) =>
  createElement("p", { "data-testid": "fixture-page" }, `Fixture page for ${workspaceId}`);

const load: HostExtensionRoute["load"] = async () => ({ default: FixturePage });

export const hostExtensionFixture: HostExtension = {
  id: "fixture",
  productName: "Fixture",
  routes: [
    { path: "pms", load },
    { path: "pms-settings", load, mode: "settings" },
  ],
};

export default hostExtensionFixture;

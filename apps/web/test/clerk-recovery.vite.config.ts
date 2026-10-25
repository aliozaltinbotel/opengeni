import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import nativeConfig from "../vite.config";
// The existing native app route and Vite owner; only the Clerk client is emulated.
export default mergeConfig(nativeConfig, {
  cacheDir: fileURLToPath(new URL("../../../.local/clerk-recovery/vite-cache", import.meta.url)),
  define: { "import.meta.env.VITE_CLERK_PUBLISHABLE_KEY": JSON.stringify("pk_test_fixture") },
  resolve: {
    alias: {
      "@clerk/react": fileURLToPath(new URL("./clerk-recovery-fixture.tsx", import.meta.url)),
    },
  },
});

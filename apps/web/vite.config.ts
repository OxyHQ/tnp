import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import reactNativeWeb from "vite-plugin-react-native-web";

const __dirname = dirname(fileURLToPath(import.meta.url));

const emptyModule = resolve(__dirname, "./src/empty-module.js");

// TNP web runs on rolldown-vite (`"vite": "npm:rolldown-vite@^7"`) so the
// `@oxyhq/services` React Native graph bundles through the maintained
// `vite-plugin-react-native-web` plugin: it aliases react-native→react-native-web,
// applies `.web.*` platform-extension priority in dev AND build, treats RN
// packages' JSX-in-.js via rolldown moduleTypes, strips Flow types, keeps
// expo-modules-core's side-effectful web polyfill from being tree-shaken, and
// defines the RN globals. The provider is the single session authority
// (device-first cold boot + zero-cookie device token); there is no app-local
// auth code.
export default defineConfig(({ mode }) => ({
  plugins: [reactNativeWeb(), tailwindcss(), react()],
  resolve: {
    alias: [
      // Deep native-only internals that hoisting can pull in transitively and
      // that have no web implementation.
      { find: /^react-native\/Libraries\/.*/, replacement: emptyModule },
      // Native-only navigation primitives; `sonner-native` named-imports
      // FullWindowOverlay, which on web renders straight through (see shim).
      {
        find: "react-native-screens",
        replacement: resolve(__dirname, "./src/shims/react-native-screens.js"),
      },
      // react-native-svg asset resolution reaches for RN's Flow-typed CJS asset
      // registry; on web the one true registry is react-native-web's.
      {
        find: "@react-native/assets-registry/registry",
        replacement: "react-native-web/dist/modules/AssetRegistry",
      },
      // Native-only key/value store: the SDK persists via localStorage on web,
      // so the RN async-storage module (only reached behind a Platform guard)
      // resolves to an empty module.
      {
        find: "@react-native-async-storage/async-storage",
        replacement: emptyModule,
      },
      // Optional native-only modules the SDK reaches only via `await import(...)`
      // behind a graceful fallback (haptics/pickers) or a native-only code path
      // (in-app auth browser). On web the fallback runs or the path is never
      // taken, so they resolve to an empty module.
      { find: "expo-web-browser", replacement: emptyModule },
      { find: "expo-document-picker", replacement: emptyModule },
      { find: "expo-haptics", replacement: emptyModule },
      { find: "expo-image-manipulator", replacement: emptyModule },
    ],
  },
  define: {
    // vite-plugin-react-native-web pins __DEV__=false and NODE_ENV=production
    // unconditionally; re-assert the mode-aware values (user config wins over
    // plugin config in Vite's merge).
    __DEV__: JSON.stringify(mode !== "production"),
    "process.env.NODE_ENV": JSON.stringify(mode),
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
  },
}));

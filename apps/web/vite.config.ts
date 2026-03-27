import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "stub-native-modules",
      resolveId(source) {
        if (source === "expo-secure-store" || source === "expo-crypto") {
          return source;
        }
      },
      load(id) {
        if (id === "expo-secure-store" || id === "expo-crypto") {
          return "export default null;";
        }
      },
    },
  ],
  resolve: {
    alias: {
      "react-native": "react-native-web",
    },
  },
  optimizeDeps: {
    exclude: ["@react-native-async-storage/async-storage"],
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
});

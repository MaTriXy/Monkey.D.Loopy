import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../../packages/operator/assets/control-center"),
    emptyOutDir: true,
    sourcemap: false,
  },
});

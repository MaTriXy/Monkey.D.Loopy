import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "es2022",
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});

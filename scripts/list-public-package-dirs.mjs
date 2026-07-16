import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
    return manifest.private !== true;
  })
  .sort();

process.stdout.write(dirs.join(" "));

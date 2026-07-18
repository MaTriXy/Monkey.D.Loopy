import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .map((dir) => ({
    dir,
    manifest: JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8")),
  }))
  .filter(({ manifest }) => manifest.private !== true);

const packageNames = new Set(manifests.map(({ manifest }) => manifest.name));
const remaining = new Map(
  manifests.map(({ dir, manifest }) => [
    dir,
    {
      name: manifest.name,
      dependencies: new Set(
        Object.keys(manifest.dependencies ?? {}).filter((dependency) => packageNames.has(dependency)),
      ),
    },
  ]),
);
const published = new Set();
const dirs = [];

while (remaining.size > 0) {
  const ready = [...remaining.entries()]
    .filter(([, entry]) => [...entry.dependencies].every((dependency) => published.has(dependency)))
    .sort(([left], [right]) => left.localeCompare(right));
  if (ready.length === 0) {
    const blocked = [...remaining.values()].map(({ name }) => name).sort().join(", ");
    throw new Error(`public package dependency cycle: ${blocked}`);
  }
  const [dir, entry] = ready[0];
  dirs.push(dir);
  published.add(entry.name);
  remaining.delete(dir);
}

process.stdout.write(dirs.join(" "));

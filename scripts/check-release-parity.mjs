import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const fail = (message) => {
  throw new Error(`release parity: ${message}`);
};
const requireTruthy = (condition, message) => {
  if (!condition) fail(message);
};

const rootManifest = readJson(join(root, "package.json"));
const version = rootManifest.version;
const tag = process.env.GITHUB_REF_TYPE === "tag"
  ? process.env.GITHUB_REF_NAME
  : process.env.GITHUB_REF?.startsWith("refs/tags/")
    ? process.env.GITHUB_REF.slice("refs/tags/".length)
    : undefined;
if (tag) requireTruthy(tag === `v${version}`, `release tag ${tag} does not match v${version}`);
const workspaceDirs = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = workspaceDirs.map((dir) => ({ dir, manifest: readJson(join(root, "packages", dir, "package.json")) }));
const publicPackages = manifests.filter(({ manifest }) => manifest.private !== true);

for (const { dir, manifest } of manifests) {
  requireTruthy(manifest.version === version, `packages/${dir} is ${manifest.version}; root is ${version}`);
}
requireTruthy(publicPackages.length === 6, `expected 6 public packages, found ${publicPackages.length}`);

const core = await import(pathToFileURL(join(root, "packages/core/dist/index.js")));
requireTruthy(core.FACTORY_VERSION === version, `FACTORY_VERSION is ${core.FACTORY_VERSION}; root is ${version}`);

const runCli = (args) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", join(root, "packages/cli/src/index.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) fail(`loopc ${args.join(" ")} exited ${result.status}: ${result.stderr}`);
  return result.stdout;
};

const help = runCli(["--help"]);
const reportedVersion = runCli(["--version"]).trim();
const targetOutput = runCli(["targets"]);
requireTruthy(reportedVersion === version, `loopc reports ${reportedVersion}; root is ${version}`);
requireTruthy(help.includes(`loopc v${version}`), "CLI help does not report the release version");
requireTruthy(help.includes(`${core.SUPPORTED_TARGETS.join(",")}|all`), "CLI help target list differs from core");
for (const target of core.SUPPORTED_TARGETS) requireTruthy(targetOutput.includes(target), `loopc targets omits ${target}`);

const docPaths = ["README.md", "SPEC.md", "docs/cli.md", "packages/cli/README.md"];
for (const path of docPaths) {
  const text = readFileSync(join(root, path), "utf8");
  for (const target of core.SUPPORTED_TARGETS) requireTruthy(text.includes(target), `${path} omits target ${target}`);
}
for (const path of ["README.md", "SPEC.md", "docs/cli.md", "CHANGELOG.md"]) {
  requireTruthy(readFileSync(join(root, path), "utf8").includes(version), `${path} omits release ${version}`);
}
for (const { manifest } of publicPackages) {
  requireTruthy(readFileSync(join(root, "README.md"), "utf8").includes(manifest.name), `README omits ${manifest.name}`);
}

const blueprint = core.getBlueprint("poll-until");
const parsed = core.loadSpecFromYaml(blueprint.yaml);
requireTruthy(parsed.validation.ok, "release parity fixture no longer validates");
const plan = core.planLoopExport(parsed.spec, "standalone");
const generated = new Map(plan.files.map((file) => [file.relativePath, file.contents]));
const generatedManifest = JSON.parse(generated.get("package.json"));
const generatedLock = JSON.parse(generated.get("loop.lock"));
requireTruthy(generatedManifest.dependencies["@loopyc/runtime"] === `^${version}`, "generated runtime dependency is stale");
requireTruthy(generatedLock.factory_version === version, "generated factory_version is stale");

console.log(`release parity ✓ ${version} · ${publicPackages.length} public packages · ${core.SUPPORTED_TARGETS.length} targets`);

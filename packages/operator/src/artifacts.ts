import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { ArtifactSpec } from "@loopyc/core";

export const DEFAULT_ARTIFACT_MAX_FILES = 1_000;
export const DEFAULT_ARTIFACT_MAX_BYTES = 50_000_000;

export interface IndexedArtifact {
  path: string;
  size: number;
  mime: string;
  sha256: string;
  modifiedAt: number;
  localUrl: string;
}

export interface ArtifactIndex {
  files: IndexedArtifact[];
  totalBytes: number;
  truncated: boolean;
  diagnostics: string[];
}

const HARD_DENY = /(^|\/)(?:\.git|\.loopy|node_modules)(?:\/|$)|(^|\/)(?:\.env[^/]*|inputs\.json|loop\.source\.yaml|loop\.lock|[^/]*(?:secret|credential|private[-_]?key)[^/]*)$/i;
const MIME: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".diff": "text/x-diff; charset=utf-8",
  ".patch": "text/x-diff; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; source += "(?:.*/)?"; }
        else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function matches(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globRegex(pattern).test(path));
}

function imageMagic(mime: string, data: Buffer): boolean {
  if (mime === "image/png") return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === "image/gif") return data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a";
  if (mime === "image/webp") return data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  return true;
}

function safeContents(path: string, mime: string): { ok: boolean; hash?: string; reason?: string } {
  const data = readFileSync(path);
  if (mime.startsWith("image/") && !imageMagic(mime, data)) return { ok: false, reason: "extension does not match image signature" };
  if (!mime.startsWith("image/")) {
    if (data.includes(0)) return { ok: false, reason: "binary content is not allowed for a text artifact" };
    const text = data.toString("utf8");
    if (text.includes("\uFFFD")) return { ok: false, reason: "text artifact is not valid UTF-8" };
    if (mime.startsWith("application/json")) {
      try { JSON.parse(text); } catch { return { ok: false, reason: "JSON artifact is malformed" }; }
    }
  }
  return { ok: true, hash: createHash("sha256").update(data).digest("hex") };
}

/** Build a bounded, allowlisted index without following symlinks or executing active content. */
export function indexArtifacts(root: string, contract: ArtifactSpec | undefined, loopId: string): ArtifactIndex {
  if (!contract || contract.include.length === 0) return { files: [], totalBytes: 0, truncated: false, diagnostics: [] };
  const absoluteRoot = realpathSync(resolve(root));
  const maxFiles = contract.max_files ?? DEFAULT_ARTIFACT_MAX_FILES;
  const maxBytes = contract.max_bytes ?? DEFAULT_ARTIFACT_MAX_BYTES;
  const exclude = contract.exclude ?? [];
  const files: IndexedArtifact[] = [];
  const diagnostics: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const full = join(directory, entry.name);
      const rel = relative(absoluteRoot, full).split(sep).join("/");
      if (HARD_DENY.test(rel)) {
        if (!entry.isDirectory() && matches(rel, contract.include)) diagnostics.push(`${rel}: secret/runtime path hard-denied`);
        continue;
      }
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        diagnostics.push(`${rel}: symlink rejected`);
        continue;
      }
      if (stat.isDirectory()) { walk(full); continue; }
      if (!stat.isFile() || !matches(rel, contract.include) || matches(rel, exclude)) continue;
      const mime = MIME[extname(rel).toLowerCase()];
      if (!mime) { diagnostics.push(`${rel}: unsupported or active-content type rejected`); continue; }
      if (files.length >= maxFiles || totalBytes + stat.size > maxBytes) {
        truncated = true;
        diagnostics.push(`artifact ceiling reached (${maxFiles} files / ${maxBytes} bytes)`);
        break;
      }
      const checked = safeContents(full, mime);
      if (!checked.ok) { diagnostics.push(`${rel}: ${checked.reason}`); continue; }
      totalBytes += stat.size;
      files.push({
        path: rel,
        size: stat.size,
        mime,
        sha256: checked.hash!,
        modifiedAt: stat.mtimeMs,
        localUrl: `/api/v1/loops/${encodeURIComponent(loopId)}/artifacts/${rel.split("/").map(encodeURIComponent).join("/")}`,
      });
    }
  };
  walk(absoluteRoot);
  return { files, totalBytes, truncated, diagnostics };
}

/** Resolve only a path that is present in the fresh safe index. */
export function resolveIndexedArtifact(root: string, index: ArtifactIndex, requested: string): { path: string; artifact: IndexedArtifact } | undefined {
  let decoded: string;
  try { decoded = requested.split("/").map((part) => decodeURIComponent(part)).join("/"); }
  catch { return undefined; }
  const artifact = index.files.find((file) => file.path === decoded);
  if (!artifact) return undefined;
  const absoluteRoot = realpathSync(resolve(root));
  const candidate = resolve(absoluteRoot, decoded);
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
  const real = realpathSync(candidate);
  if (!real.startsWith(`${absoluteRoot}${sep}`)) return undefined;
  return { path: real, artifact };
}

/** Open without following a final symlink and verify the bytes still match the indexed digest. */
export function readIndexedArtifact(root: string, index: ArtifactIndex, requested: string): { data: Buffer; artifact: IndexedArtifact } | undefined {
  const resolved = resolveIndexedArtifact(root, index, requested);
  if (!resolved) return undefined;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number | undefined;
  try {
    fd = openSync(resolved.path, constants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== resolved.artifact.size) return undefined;
    const data = readFileSync(fd);
    if (createHash("sha256").update(data).digest("hex") !== resolved.artifact.sha256) return undefined;
    return { data, artifact: resolved.artifact };
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** End-to-end (still pure): raw object/YAML -> parse -> normalize -> validate -> LoopSpec. */
import { parse as parseYaml } from "yaml";
import { parseLoopSpec } from "./schema.js";
import { asLoopSpec, normalize } from "./normalize.js";
import { validate, type ValidationResult } from "./validate.js";
import type { LoopSpec } from "./types.js";

export interface ProcessResult {
  /** Structural (zod) parse errors; present only when parsing failed. */
  parseErrors?: string[];
  /** Semantic validation result; present when parsing succeeded. */
  validation?: ValidationResult;
  /** Whether caps were auto-injected during normalization. */
  capsInjected?: boolean;
  /** The validated, canonical spec — present only when validation has no errors. */
  spec?: LoopSpec;
}

/** Process an already-deserialized object. */
export function processRaw(raw: unknown): ProcessResult {
  const parsed = parseLoopSpec(raw);
  if (!parsed.ok) return { parseErrors: parsed.errors };
  const normalized = normalize(parsed.data);
  const validation = validate(normalized);
  const result: ProcessResult = { validation, capsInjected: normalized.capsInjected };
  if (validation.ok) result.spec = asLoopSpec(normalized.spec);
  return result;
}

/** Process a YAML (or JSON) document string. */
export function loadSpecFromYaml(text: string): ProcessResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { parseErrors: [`YAML parse error: ${(e as Error).message}`] };
  }
  return processRaw(raw);
}

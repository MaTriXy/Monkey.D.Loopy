/** Public API of @loopyc/core — the pure, zero-I/O brain of Monkey D Loopy. */

export { FACTORY_VERSION } from "./version.js";
export {
  RecipeManifestSchema,
  parseRecipeSource,
  createRecipeCatalog,
  type RecipeManifest,
  type RecipeSource,
  type Recipe,
  type RecipeDiagnostic,
  type RecipeParseResult,
  type RecipeCatalog,
  type RecipeCatalogResult,
} from "./recipe.js";
export * from "./types.js";
export { LoopSpecSchema, parseLoopSpec, type RawLoopSpec, type ParseOk, type ParseErr } from "./schema.js";
export { normalize, asLoopSpec, type NormalizedSpec } from "./normalize.js";
export {
  validate,
  formatValidation,
  type Diagnostic,
  type Severity,
  type ValidationResult,
} from "./validate.js";
export { processRaw, loadSpecFromYaml, type ProcessResult } from "./pipeline.js";
export {
  planLoopExport,
  planAll,
  SUPPORTED_TARGETS,
  CAPABILITY_MATRIX,
  capabilityWarnings,
  usedCapabilities,
  type Adapter,
  type PlanOptions,
  type PlanResult,
  type PlannedFile,
  type PlannedFileKind,
  type Capability,
  type Support,
} from "./plan/index.js";
export {
  parseExpr,
  parseGuard,
  parseInterpolations,
  evaluate,
  collectRefs,
  validateRefs,
  ALLOWED_ROOTS,
  type ExprNode,
  type EvalContext,
} from "./expr.js";
export { terminationGrounding, type GroundingClass, type GroundingInput, type TerminationGrounding } from "./grounding.js";
export { parseDuration, isValidDuration } from "./duration.js";
export { toToon, LOOPSPEC_GUIDE } from "./toon.js";
export { listBlueprints, getBlueprint, type Blueprint } from "./catalog.js";

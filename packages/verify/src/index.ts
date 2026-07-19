/** @loopyc/verify — dry-run verification + scorecard, and the codegen-free interpreter. */
export { interpretLoop, sampleInputs } from "./interpret.js";
export {
  verifyLoop,
  scoreLoop,
  formatVerify,
  formatScore,
  type VerifyReport,
  type VerifyFixtures,
  type VerifyOptions,
  type Scorecard,
} from "./verify.js";

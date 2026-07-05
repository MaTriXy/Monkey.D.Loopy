/**
 * Skill-eval grader: scores an NL→spec attempt with the REAL factory code. A spec passes a
 * fixture when it validates, verifies (bounded/deterministic/resumable), uses an allowed
 * pattern, picks a termination signal at least as strong as required, and scores above the bar.
 */
import { loadSpecFromYaml } from "@loopyc/core";
import { scoreLoop, verifyLoop } from "@loopyc/verify";

export const SIGNAL_TIER: Record<string, number> = {
  oracle: 4,
  "state-predicate": 3,
  "llm-judge": 2,
  "self-assess": 1,
};

export interface SkillFixture {
  id: string;
  nl: string;
  expectedPatterns: string[];
  minTier: keyof typeof SIGNAL_TIER;
  minScore: number;
  /** A hand-authored good spec — used to test the grader and as the offline fallback. */
  golden: string;
}

export interface SkillGrade {
  id: string;
  validates: boolean;
  bounded: boolean;
  deterministic: boolean;
  reachableExit: boolean;
  patternMatch: boolean;
  signalTierOk: boolean;
  score: number;
  grade: string;
  pass: boolean;
  notes: string[];
}

export async function gradeSpec(fx: SkillFixture, yaml: string): Promise<SkillGrade> {
  const r = loadSpecFromYaml(yaml);
  if (!r.spec) {
    return {
      id: fx.id,
      validates: false,
      bounded: false,
      deterministic: false,
      reachableExit: false,
      patternMatch: false,
      signalTierOk: false,
      score: 0,
      grade: "F",
      pass: false,
      notes: [`invalid: ${JSON.stringify(r.validation?.errors ?? r.parseErrors)}`],
    };
  }
  const spec = r.spec;
  const report = await verifyLoop(spec, r.capsInjected ?? false);
  const card = scoreLoop(spec, report);
  const patternMatch = fx.expectedPatterns.includes(spec.pattern);
  const signalTierOk = SIGNAL_TIER[spec.terminate.signal]! >= SIGNAL_TIER[fx.minTier]!;
  const reachableExit = true; // validation passed the unreachable-exit gate
  const notes: string[] = [];
  if (!patternMatch) notes.push(`pattern '${spec.pattern}' not in [${fx.expectedPatterns.join(", ")}]`);
  if (!signalTierOk) notes.push(`signal '${spec.terminate.signal}' weaker than required '${fx.minTier}'`);
  if (card.total < fx.minScore) notes.push(`score ${card.total} < min ${fx.minScore}`);
  if (!report.bounded) notes.push("not bounded");
  if (!report.deterministic) notes.push("not deterministic");
  if (!report.resumeStable) notes.push("not resume-stable");
  const pass =
    report.bounded && report.deterministic && report.resumeStable && patternMatch && signalTierOk && card.total >= fx.minScore;
  return {
    id: fx.id,
    validates: true,
    bounded: report.bounded,
    deterministic: report.deterministic,
    reachableExit,
    patternMatch,
    signalTierOk,
    score: card.total,
    grade: card.grade,
    pass,
    notes,
  };
}

export interface SkillAggregate {
  count: number;
  patternRate: number;
  signalRate: number;
  reachableRate: number;
  meanScore: number;
  passRate: number;
  pass: boolean;
}

/** Thresholds: ≥90% correct pattern, 100% reachable exit, ≥90% strong-enough signal, ≥80% pass. */
export function aggregate(grades: SkillGrade[]): SkillAggregate {
  const n = grades.length || 1;
  const rate = (f: (g: SkillGrade) => boolean) => grades.filter(f).length / n;
  const patternRate = rate((g) => g.patternMatch);
  const signalRate = rate((g) => g.signalTierOk);
  const reachableRate = rate((g) => g.reachableExit && g.validates);
  const meanScore = grades.reduce((s, g) => s + g.score, 0) / n;
  const passRate = rate((g) => g.pass);
  return {
    count: grades.length,
    patternRate,
    signalRate,
    reachableRate,
    meanScore,
    passRate,
    pass: patternRate >= 0.9 && reachableRate >= 1 && signalRate >= 0.9 && passRate >= 0.8,
  };
}

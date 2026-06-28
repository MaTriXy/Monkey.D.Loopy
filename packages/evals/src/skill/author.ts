/**
 * Provider-agnostic LLM author for the skill-eval. Uses the runtime's OpenAI-compatible client
 * (resolveLlm + chatComplete) — NO vendor lock. Configure with LOOPY_LLM_* or any provider key
 * (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY /
 * AI_GATEWAY_API_KEY). With nothing configured, the runner falls back to the golden specs.
 */
import { LOOPSPEC_GUIDE } from "@loopy/core";
import { chatComplete, resolveLlm } from "@loopy/runtime";

export function llmAuthorAvailable(): boolean {
  return resolveLlm() !== null;
}

export async function llmAuthorSpec(nl: string): Promise<string> {
  const cfg = resolveLlm();
  if (!cfg) throw new Error("no LLM configured (set LOOPY_LLM_API_KEY/BASE_URL/MODEL or any provider key)");
  const system =
    "You are the /loopy authoring layer. Output ONLY a single valid LoopSpec YAML document — " +
    "no prose, no markdown fences. Choose the strongest available termination signal, set " +
    "explicit caps, and make the exit reachable. Follow this guide strictly:\n\n" +
    LOOPSPEC_GUIDE;
  const { text } = await chatComplete(cfg, system, `Author a LoopSpec for this goal:\n\n${nl}`);
  return text
    .replace(/^```ya?ml\s*/i, "")
    .replace(/```$/m, "")
    .trim();
}

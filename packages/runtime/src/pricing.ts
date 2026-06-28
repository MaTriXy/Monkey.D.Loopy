/**
 * Model pricing → real $-cost metering, so the `usd` budget cap actually bites for the
 * provider-agnostic `llm` harness (which only ever knows token counts).
 *
 * Prices are USD per 1M tokens (input / output), the units every provider publishes. They
 * drift over time and are NOT a billing source of truth — they exist to give the cost CAP a
 * concrete number to meter against. Override per-run with LOOPY_LLM_PRICE_IN / LOOPY_LLM_PRICE_OUT
 * (USD per 1M tokens) for any model not in the table or when a price changes.
 */

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  inPerMTok: number;
  /** USD per 1M output (completion) tokens. */
  outPerMTok: number;
}

/** Keyed by a normalized model id (provider prefix + date suffix stripped — see normalizeModel). */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6 },
  "gpt-4o": { inPerMTok: 2.5, outPerMTok: 10 },
  "gpt-4.1": { inPerMTok: 2, outPerMTok: 8 },
  "gpt-4.1-mini": { inPerMTok: 0.4, outPerMTok: 1.6 },
  "gpt-4.1-nano": { inPerMTok: 0.1, outPerMTok: 0.4 },
  "o3-mini": { inPerMTok: 1.1, outPerMTok: 4.4 },
  "o3": { inPerMTok: 2, outPerMTok: 8 },
  // Anthropic (OpenAI-compat endpoint)
  "claude-opus-4": { inPerMTok: 15, outPerMTok: 75 },
  "claude-sonnet-4": { inPerMTok: 3, outPerMTok: 15 },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15 },
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  "claude-3-5-haiku": { inPerMTok: 0.8, outPerMTok: 4 },
  "claude-3-5-sonnet": { inPerMTok: 3, outPerMTok: 15 },
  // Google Gemini
  "gemini-2.0-flash": { inPerMTok: 0.1, outPerMTok: 0.4 },
  "gemini-2.5-flash": { inPerMTok: 0.3, outPerMTok: 2.5 },
  "gemini-2.5-pro": { inPerMTok: 1.25, outPerMTok: 10 },
  // Groq (Llama)
  "llama-3.3-70b-versatile": { inPerMTok: 0.59, outPerMTok: 0.79 },
  "llama-3.1-8b-instant": { inPerMTok: 0.05, outPerMTok: 0.08 },
};

/**
 * Normalize a model id for table lookup: drop a provider prefix (`openai/gpt-4o` → `gpt-4o`,
 * common on OpenRouter / the AI Gateway) and a trailing date stamp
 * (`claude-sonnet-4-6-20250930` → `claude-sonnet-4-6`, `gpt-4o-2024-08-06` → `gpt-4o`).
 */
export function normalizeModel(model: string): string {
  let m = model.trim().toLowerCase();
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  m = m.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return m;
}

/**
 * Compute USD cost for a call, or `undefined` when the model is unknown AND no env override is
 * set (so the caller can warn that the $ cap is unmeterable rather than silently treating it as 0).
 */
export function priceUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  env: Record<string, string | undefined> = process.env
): number | undefined {
  const inOverride = priceOverride(env.LOOPY_LLM_PRICE_IN);
  const outOverride = priceOverride(env.LOOPY_LLM_PRICE_OUT);
  const table = MODEL_PRICING[normalizeModel(model)];
  const inPer = inOverride ?? table?.inPerMTok;
  const outPer = outOverride ?? table?.outPerMTok;
  if (inPer === undefined || outPer === undefined) return undefined;
  return (promptTokens * inPer + completionTokens * outPer) / 1_000_000;
}

/** A price override is only honored when it is a non-empty, finite, non-negative number.
 *  An empty/blank string (a common CI/.env mistake) must fall through to the table — Number("")
 *  is 0, which would otherwise silently price every call at $0 and make the usd cap a no-op. */
function priceOverride(raw: string | undefined): number | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Whether a model's $ cost can be metered (table hit or env override) — used by doctor/preflight. */
export function isCostMeterable(model: string, env: Record<string, string | undefined> = process.env): boolean {
  if (priceOverride(env.LOOPY_LLM_PRICE_IN) !== undefined && priceOverride(env.LOOPY_LLM_PRICE_OUT) !== undefined) return true;
  return MODEL_PRICING[normalizeModel(model)] !== undefined;
}

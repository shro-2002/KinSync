/**
 * Pure arg/env parsing for scripts/live-eval.ts, split out so it is unit-testable offline
 * (no process.exit, no network, no SDK construction). Enforces: exactly one case per run
 * (no multi-case execution), no silent model default when --model is given.
 */
import { DEFAULT_ANTHROPIC_MODEL } from './anthropic-planner.js';
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from './ollama-planner.js';

export const LIVE_EVAL_CASES = ['golden', 'injection', 'status'] as const;
export type LiveEvalCase = (typeof LIVE_EVAL_CASES)[number];
export const PROVIDERS = ['anthropic', 'ollama'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface LiveEvalConfig {
    /** Which backend to run against. Only ever 'ollama' when --provider ollama was explicitly given. */
    provider: Provider;
    live: boolean;
    hasCredentials: boolean;
    model: string;
    /** True only when --model was explicitly passed (vs. falling back to the provider's default). */
    modelExplicit: boolean;
    effort: 'low' | 'medium' | 'high';
    ollamaBaseUrl: string;
    /** Raw, unvalidated case token(s) as given — may be invalid or multiple; see validateCase. */
    rawCase: string;
    /** Raw --provider token as given (unvalidated; see validateProvider). Empty string if omitted. */
    rawProvider: string;
    /** Optional paraphrase of the golden utterance for case=golden (Phase 3E reliability runs). Empty string if omitted. */
    utterance: string;
}

export function parseLiveEvalArgs(argv: readonly string[], env: NodeJS.ProcessEnv): LiveEvalConfig {
    const flag = (name: string) => argv.includes(`--${name}`);
    const option = (name: string, fallback: string) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
    };
    const rawProvider = option('provider', '');
    const provider: Provider = (PROVIDERS as readonly string[]).includes(rawProvider) ? (rawProvider as Provider) : 'anthropic';
    const modelExplicit = argv.includes('--model');
    const defaultModel = provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : DEFAULT_ANTHROPIC_MODEL;
    return {
        provider,
        live: flag('live'),
        hasCredentials: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
        model: option('model', env.CARELOOP_LLM_MODEL ?? defaultModel),
        modelExplicit: modelExplicit || Boolean(env.CARELOOP_LLM_MODEL),
        effort: option('effort', 'medium') as 'low' | 'medium' | 'high',
        ollamaBaseUrl: option('ollama-url', DEFAULT_OLLAMA_BASE_URL),
        rawCase: option('case', ''),
        rawProvider,
        utterance: option('utterance', '')
    };
}

export function validateProvider(raw: string): { ok: true; value: Provider } | { ok: false; reason: string } {
    if (!(PROVIDERS as readonly string[]).includes(raw)) return { ok: false, reason: `unknown provider "${raw}" (one of: ${PROVIDERS.join(', ')})` };
    return { ok: true, value: raw as Provider };
}

export type CaseValidation = { ok: true; value: LiveEvalCase } | { ok: false; reason: string };

/** Exactly one known case, no comma-lists, nothing implicit. */
export function validateCase(raw: string): CaseValidation {
    if (!raw) return { ok: false, reason: `--case is required (one of: ${LIVE_EVAL_CASES.join(', ')})` };
    if (raw.includes(',')) return { ok: false, reason: 'exactly one --case per run; multi-case execution is disabled' };
    if (!(LIVE_EVAL_CASES as readonly string[]).includes(raw)) return { ok: false, reason: `unknown case "${raw}" (one of: ${LIVE_EVAL_CASES.join(', ')})` };
    return { ok: true, value: raw as LiveEvalCase };
}

import { mkdir } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Models are discovered live, never hard-coded:
 * 1. Claude Code itself reports the models available to the signed-in account
 *    (`supportedModels()`), for both API keys and subscription tokens. Aliases such as
 *    "default", "opus" and "sonnet" always resolve to the newest model, so new releases
 *    appear as soon as Claude Code is updated.
 * 2. For API keys, Anthropic's Models API adds every specific model id the key can use,
 *    so a model released after the installed Claude Code is still selectable.
 * The probe starts Claude Code without sending a prompt, so it costs no tokens.
 */

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  resolvedModel?: string;
  source: 'claude-code' | 'anthropic-api';
}

const CACHE_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; models: ModelOption[] }>();

async function fromClaudeCode(env: Record<string, string>, cwd: string): Promise<ModelOption[]> {
  await mkdir(cwd, { recursive: true });
  const abortController = new AbortController();
  // Streaming input that never yields: Claude Code starts and answers control requests,
  // but no message is ever sent to the model.
  async function* idle(): AsyncGenerator<never> {
    await new Promise<void>((resolve) => abortController.signal.addEventListener('abort', () => resolve()));
  }
  const q = query({ prompt: idle(), options: { cwd, env, settingSources: [], abortController } });
  const timer = setTimeout(() => abortController.abort(), 45_000);
  try {
    const models = await q.supportedModels();
    return models.map((m) => ({
      id: m.value,
      label: m.displayName,
      description: m.description,
      resolvedModel: m.resolvedModel,
      source: 'claude-code' as const,
    }));
  } finally {
    clearTimeout(timer);
    abortController.abort();
  }
}

async function fromAnthropicApi(apiKey: string): Promise<ModelOption[]> {
  const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: { id: string; display_name?: string }[] };
  return (body.data ?? []).map((m) => ({ id: m.id, label: m.display_name ?? m.id, description: m.id, source: 'anthropic-api' as const }));
}

export async function listModels(
  cacheKey: string,
  opts: { env: Record<string, string>; probeDir: string; apiKey?: string; refresh?: boolean },
): Promise<{ models: ModelOption[]; fetchedAt: string; errors: string[] }> {
  const hit = cache.get(cacheKey);
  if (hit && !opts.refresh && Date.now() - hit.at < CACHE_MS) {
    return { models: hit.models, fetchedAt: new Date(hit.at).toISOString(), errors: [] };
  }
  const errors: string[] = [];
  const [cc, api] = await Promise.all([
    fromClaudeCode(opts.env, opts.probeDir).catch((e: Error) => {
      errors.push(`Claude Code: ${e.message}`);
      return [] as ModelOption[];
    }),
    opts.apiKey
      ? fromAnthropicApi(opts.apiKey).catch((e: Error) => {
          errors.push(`Anthropic API: ${e.message}`);
          return [] as ModelOption[];
        })
      : Promise.resolve([] as ModelOption[]),
  ]);
  const seen = new Set(cc.map((m) => m.id));
  const models = [...cc, ...api.filter((m) => !seen.has(m.id))];
  if (models.length) cache.set(cacheKey, { at: Date.now(), models });
  return { models, fetchedAt: new Date().toISOString(), errors };
}

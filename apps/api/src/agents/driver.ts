import path from 'node:path';
import { query, type CanUseTool, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Runs Claude Code through the official Claude Agent SDK. The SDK ships its own
 * Claude Code binary (updated with `npm run update:claude`), so the agent here is
 * the same Claude Code a developer runs in their terminal.
 */

export type AgentMode = 'plan' | 'execute';

/** Normalised events the platform stores and streams to the browser. */
export type AgentEvent =
  | { kind: 'session'; sdkSessionId: string; model?: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; output: string }
  | { kind: 'result'; isError: boolean; subtype: string; costUsd: number; inputTokens: number; outputTokens: number; durationMs: number; text?: string };

export interface AgentRunInput {
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  model: string;
  mode: AgentMode;
  resume?: string;
  abortController: AbortController;
  canUseTool: CanUseTool;
  appendSystemPrompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
}

export interface AgentDriver {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

/** Server environment variables Claude Code may see. Everything else (DATABASE_URL, VAULT_KEY, ...) is withheld. */
const PASS_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CLAUDE_CODE_GIT_BASH_PATH', 'LANG', 'TERM',
];

/**
 * Builds the agent's environment from scratch: its own HOME and Claude config directory
 * (so the server user's own `claude` login is never picked up) plus the developer's credential.
 */
export function agentEnv(home: string, auth: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k]!;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CLAUDE_AGENT_SDK_CLIENT_APP: 'engineering-platform/0.1',
    DISABLE_AUTOUPDATER: '1',
    ...auth,
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : c?.type === 'image' ? '[image]' : ''))
      .join('\n');
  }
  return '';
}

const MAX_OUTPUT = 20_000;
const clip = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n… (${s.length - MAX_OUTPUT} more characters)` : s);

/** Maps one SDK message to zero or more platform events. Pure; unit-tested. */
export function mapSdkMessage(msg: SDKMessage): AgentEvent[] {
  switch (msg.type) {
    case 'system':
      return msg.subtype === 'init' ? [{ kind: 'session', sdkSessionId: msg.session_id, model: (msg as { model?: string }).model }] : [];
    case 'assistant': {
      const out: AgentEvent[] = [];
      for (const block of msg.message.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
        if (block.type === 'text' && block.text?.trim()) out.push({ kind: 'text', text: block.text });
        else if (block.type === 'tool_use') out.push({ kind: 'tool_use', toolUseId: block.id!, name: block.name!, input: block.input });
      }
      return out;
    }
    case 'user': {
      const content = (msg.message as { content?: unknown }).content;
      if (!Array.isArray(content)) return [];
      return content
        .filter((b): b is { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean } => b?.type === 'tool_result')
        .map((b) => ({ kind: 'tool_result' as const, toolUseId: b.tool_use_id, isError: !!b.is_error, output: clip(toolResultText(b.content)) }));
    }
    case 'result': {
      const r = msg as { subtype: string; is_error?: boolean; total_cost_usd?: number; duration_ms?: number; usage?: { input_tokens?: number; output_tokens?: number }; result?: string; errors?: string[] };
      return [{
        kind: 'result',
        subtype: r.subtype,
        isError: r.subtype !== 'success' || !!r.is_error,
        costUsd: r.total_cost_usd ?? 0,
        inputTokens: r.usage?.input_tokens ?? 0,
        outputTokens: r.usage?.output_tokens ?? 0,
        durationMs: r.duration_ms ?? 0,
        text: r.result ?? r.errors?.join('\n'),
      }];
    }
    default:
      return [];
  }
}

export class ClaudeSdkDriver implements AgentDriver {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const q = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        env: input.env,
        model: input.model === 'default' ? undefined : input.model,
        resume: input.resume,
        abortController: input.abortController,
        // Plan mode: Claude may read and explore but cannot change files.
        // Execute mode: file edits are accepted; every other tool goes through canUseTool.
        permissionMode: input.mode === 'plan' ? 'plan' : 'acceptEdits',
        canUseTool: input.canUseTool,
        // Isolation: never load settings from the repository (its .claude/settings.json could
        // define hooks that run commands) or from the server user's ~/.claude.
        settingSources: [],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.appendSystemPrompt },
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd,
      },
    });
    for await (const msg of q) {
      for (const ev of mapSdkMessage(msg)) yield ev;
    }
  }
}

import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentDriver, AgentEvent, AgentRunInput } from '../src/agents/driver.js';

/**
 * Stands in for Claude in end-to-end tests. It goes through the same permission
 * callback as the real SDK, so plan capture, policy and approvals are exercised.
 *
 * - plan mode: reads a file, then proposes a plan via ExitPlanMode
 * - execute mode: edits src/retry.js; if the prompt mentions "clean", first asks to run `rm -rf build`
 */
export class ScriptedDriver implements AgentDriver {
  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const signal = input.abortController.signal;
    const opts = { signal } as Parameters<AgentRunInput['canUseTool']>[2];
    yield { kind: 'session', sdkSessionId: `scripted-${Date.now()}` };

    if (/environment variables/i.test(input.prompt)) {
      // Reports what the platform gave it, and (deliberately) tries to print a secret value.
      const names = /Environment variables set for this environment[^:]*: ([A-Z0-9_, ]+)\./.exec(input.appendSystemPrompt)?.[1] ?? 'none';
      yield { kind: 'text', text: `Variables I can use: ${names}` };
      yield { kind: 'text', text: `PAYMENT_SECRET is ${input.env.PAYMENT_SECRET ?? 'missing'}` };
      yield { kind: 'result', isError: false, subtype: 'success', costUsd: 0.001, inputTokens: 10, outputTokens: 5, durationMs: 100, text: 'Done' };
      return;
    }

    if (input.mode === 'plan') {
      yield { kind: 'text', text: 'Let me look at how retries work.' };
      yield { kind: 'tool_use', toolUseId: 't1', name: 'Read', input: { file_path: path.join(input.cwd, 'src/retry.js') } };
      const content = await readFile(path.join(input.cwd, 'src/retry.js'), 'utf8').catch(() => '');
      yield { kind: 'tool_result', toolUseId: 't1', isError: false, output: content };
      await input.canUseTool('ExitPlanMode', { plan: '1. Raise MAX_RETRIES to 5 in src/retry.js\n2. Run the tests' }, opts);
      return;
    }

    if (/clean/i.test(input.prompt)) {
      const decision = await input.canUseTool('Bash', { command: 'rm -rf build' }, opts);
      yield { kind: 'text', text: decision.behavior === 'allow' ? 'Cleaned the build folder.' : 'Skipped cleaning.' };
    }

    const target = path.join(input.cwd, 'src/retry.js');
    const edit = await input.canUseTool('Edit', { file_path: target }, opts);
    if (edit.behavior === 'allow') {
      yield { kind: 'tool_use', toolUseId: 't2', name: 'Edit', input: { file_path: target } };
      await writeFile(target, 'export const MAX_RETRIES = 5;\n');
      yield { kind: 'tool_result', toolUseId: 't2', isError: false, output: 'Updated src/retry.js' };
    }
    yield { kind: 'text', text: 'I raised MAX_RETRIES to 5.' };
    yield { kind: 'result', isError: false, subtype: 'success', costUsd: 0.0123, inputTokens: 1200, outputTokens: 300, durationMs: 1500, text: 'Done' };
  }
}

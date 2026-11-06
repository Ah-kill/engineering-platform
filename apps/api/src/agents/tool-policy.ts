import path from 'node:path';

/**
 * Decides what Claude may do in a workspace, independently of what the model or the
 * repository's contents ask for. Three outcomes: allow, deny, or ask the developer.
 *
 * This is a guardrail, not a sandbox. With the local runtime, shell commands run as the
 * server user; the container runtime (next phase) is what provides real isolation.
 */

export type ToolDecision = { action: 'allow' } | { action: 'deny'; reason: string } | { action: 'ask'; reason: string };

/** Never allowed: pushing or rewiring git (the platform does that), reading credentials, privilege escalation. */
const HARD_DENY: [RegExp, string][] = [
  [/\bgit\s+push\b/i, 'Pushing is done by the platform after you review the changes'],
  [/\bgit\s+(remote|config|credential)\b/i, 'Git remotes and configuration are managed by the platform'],
  [/\.git[\\/](config|hooks)/i, 'Git configuration is managed by the platform'],
  [/\b(sudo|runas|su)\s/i, 'Privilege escalation is not allowed'],
  [/\b(ssh|scp|sftp)\s/i, 'Remote shell access is not allowed'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)/i, 'Piping downloads into a shell is not allowed'],
  [/(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|DATABASE_URL|VAULT_KEY|GITHUB_TOKEN)/, 'Reading credentials is not allowed'],
  [/(^|[\s;&|])(printenv|env|set)\s*($|[;&|])/i, 'Dumping environment variables is not allowed'],
  [/\$env:|Get-ChildItem\s+env:|\[Environment\]::GetEnvironmentVariable/i, 'Reading environment variables is not allowed'],
  [/(\.credentials\.json|vault\.key|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/])/i, 'Reading credential files is not allowed'],
];

/** Allowed only after the developer approves in the chat. */
const NEEDS_APPROVAL: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*\s+|-[a-z]*f[a-z]*\s+)+/i, 'Recursive or forced delete'],
  [/\b(Remove-Item|rd|rmdir)\b.*(-Recurse|\/s)/i, 'Recursive delete'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|rebase|branch\s+-D|checkout\s+--\s|restore\s)/i, 'Discards or rewrites git history or changes'],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, 'Publishing a package'],
  [/\b(docker|podman|kubectl|helm)\b/i, 'Container or cluster command'],
  [/\bterraform\s+(apply|destroy|import)\b/i, 'Infrastructure change'],
  [/\b(aws|az|gcloud)\s/i, 'Cloud CLI command'],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, 'Destructive database statement'],
  [/\b(shutdown|reboot|mkfs|format)\b/i, 'System command'],
];

const PATH_TOOLS: Record<string, string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

function insideRepo(repoRoot: string, p: unknown): boolean {
  if (typeof p !== 'string' || !p) return true; // tool defaults to the working directory
  // Inside the container paths are POSIX (/ws/repo/...); on the host they follow the OS.
  const P = repoRoot.startsWith('/') ? path.posix : path;
  const resolved = P.resolve(repoRoot, p);
  const root = P.resolve(repoRoot);
  const rel = P.relative(root, resolved);
  if (rel.startsWith('..') || P.isAbsolute(rel)) return false;
  return rel.split(P.sep)[0]?.toLowerCase() !== '.git' || !/config|hooks/i.test(rel);
}

export function decideTool(repoRoot: string, toolName: string, input: Record<string, unknown>, blockedPath?: string): ToolDecision {
  if (blockedPath) return { action: 'deny', reason: `Access outside the workspace is not allowed (${blockedPath})` };

  const pathFields = PATH_TOOLS[toolName];
  if (pathFields) {
    for (const f of pathFields) {
      if (!insideRepo(repoRoot, input[f])) return { action: 'deny', reason: 'Files outside the workspace cannot be accessed' };
    }
    return { action: 'allow' };
  }

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = String(input.command ?? '');
    for (const [re, reason] of HARD_DENY) if (re.test(command)) return { action: 'deny', reason };
    for (const [re, reason] of NEEDS_APPROVAL) if (re.test(command)) return { action: 'ask', reason };
    return { action: 'allow' };
  }

  // MCP servers are not configured by the platform; refuse anything that slips in.
  if (toolName.startsWith('mcp__')) return { action: 'deny', reason: 'External tool servers are not enabled' };

  return { action: 'allow' };
}

/** Removes known secret values from anything about to be stored or streamed. */
export function redactSecrets<T>(value: T, secrets: string[]): T {
  const live = secrets.filter((s) => s && s.length >= 8);
  if (!live.length) return value;
  let json = JSON.stringify(value);
  for (const s of live) json = json.split(JSON.stringify(s).slice(1, -1)).join('[redacted]');
  return JSON.parse(json) as T;
}

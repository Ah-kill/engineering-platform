import path from 'node:path';
import { analyzeCommand, flatten } from './command-parse.js';

/**
 * Decides what Claude may do in a workspace, independently of what the model or the
 * repository's contents ask for. Three outcomes: allow, deny, or ask the developer.
 *
 * This is a guardrail, not a sandbox. With the local runtime, shell commands run as the
 * server user; the container runtime (next phase) is what provides real isolation.
 */

export type ToolDecision = { action: 'allow' } | { action: 'deny'; reason: string } | { action: 'ask'; reason: string };

const ENV_DUMP = /(^|[\s;&|])(printenv|env|set)\s*($|[;&|])/i;

/** Never allowed: pushing or rewiring git (the platform does that), reading credentials, privilege escalation. */
const HARD_DENY: [RegExp, string][] = [
  [/\bgit\s+push\b/i, 'Pushing is done by the platform after you review the changes'],
  [/\bgit\s+(remote|config|credential)\b/i, 'Git remotes and configuration are managed by the platform'],
  [/\.git[\\/](config|hooks)/i, 'Git configuration is managed by the platform'],
  [/\b(sudo|runas|su)\s/i, 'Privilege escalation is not allowed'],
  [/\b(ssh|scp|sftp)\s/i, 'Remote shell access is not allowed'],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(sh|bash|zsh|pwsh|powershell|iex)/i, 'Piping downloads into a shell is not allowed'],
  [/(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|DATABASE_URL|VAULT_KEY|GITHUB_TOKEN)/, 'Reading credentials is not allowed'],
  [ENV_DUMP, 'Dumping environment variables is not allowed'],
  [/\$env:|Get-ChildItem\s+env:|\[Environment\]::GetEnvironmentVariable/i, 'Reading environment variables is not allowed'],
  [/(\.credentials\.json|vault\.key|[\\/]\.ssh[\\/]|[\\/]\.aws[\\/])/i, 'Reading credential files is not allowed'],
  [/\/proc\/[^/\s]*\/environ\b/i, 'Reading process environments is not allowed'],
];

/** Programs that print the environment when run as a command (after quotes are resolved by the parser). */
const ENV_PRINTERS = new Set(['printenv', 'set', 'export', 'declare', 'typeset', 'compgen']);
function dumpsEnvironment(argv: string[]): boolean {
  const [prog = '', ...args] = argv;
  if (ENV_PRINTERS.has(prog)) return prog === 'export' || prog === 'set' ? args.length === 0 || args.every((a) => a.startsWith('-')) : true;
  // `env` with no program to run (only options and NAME=value) prints everything.
  if (prog === 'env') return !args.some((a) => !a.startsWith('-') && !a.includes('='));
  return false;
}

/** Allowed only after the developer approves in the chat. */
const NEEDS_APPROVAL: [RegExp, string][] = [
  [/\brm\s+(-[a-z]*r[a-z]*\s+|-[a-z]*f[a-z]*\s+)+/i, 'Recursive or forced delete'],
  [/\b(Remove-Item|rd|rmdir)\b.*(-Recurse|\/s)/i, 'Recursive delete'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|rebase|branch\s+-D|checkout\s+--\s|restore\s)/i, 'Discards or rewrites git history or changes'],
  [/\b(npm|pnpm|yarn)\s+publish\b/i, 'Publishing a package'],
  [/\b(docker|podman|kubectl|helm)\b/i, 'Container or cluster command'],
  [/\bterraform\s+(apply|destroy|import)\b/i, 'Infrastructure change'],
  [/\b(az|gcloud)\s/i, 'Cloud CLI command'],
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
  // Nothing under .git (including the .git file itself) is for Claude's file tools: git
  // commands read history, and rewriting .git could redirect the platform's own git.
  return rel.split(P.sep)[0]?.toLowerCase().replace(/[. ]+$/, '') !== '.git';
}

/** Where the run happens. Protected (production) environments get the stricter command rules. */
export interface PolicyContext {
  environmentKind?: string;
  protected?: boolean;
}

const ask = (reason: string): ToolDecision => ({ action: 'ask', reason });

// ---- High-risk commands: approval in every environment ------------------------------

const DB_CLIENTS = new Set([
  'psql', 'pgcli', 'pg_dump', 'pg_dumpall', 'pg_restore', 'mysql', 'mariadb', 'mysqldump', 'mysqlsh', 'mycli',
  'mongo', 'mongosh', 'mongodump', 'mongorestore', 'mongoimport', 'mongoexport', 'sqlplus', 'sqlcmd', 'isql',
  'redis-cli', 'cqlsh', 'clickhouse-client', 'cockroach',
]);
const MIGRATION_TOOLS = new Set(['alembic', 'flyway', 'liquibase', 'dbmate', 'goose', 'sqitch']);
/** Package scripts named like a deploy or a database change (`npm run deploy`, `yarn db:reset`). */
const RISKY_SCRIPT = /(^|[:_-])(deploy|migrate|migration|migrations|release|destroy|rollback|seed)([:_-]|$)|^db[:_-]/i;

/** Text checks on the command with quotes removed: catches programs started by inline code (`node -e`, `python -c`). */
const HIGH_RISK_TEXT: [RegExp, string][] = [
  [/\b(psql|pg_dump|pg_restore|mysql|mariadb|mysqldump|mongosh?|sqlplus|sqlcmd|redis-cli)\b/i, 'Database client: connects to a database directly'],
  [/\b(prisma\s+(migrate|db)|knex\s+(migrate|seed)|sequelize(-cli)?\s+db:|(rails|rake)\s+db:|alembic|flyway|liquibase)\b/i, 'Database migration'],
  [/\b(terraform|tofu)\s+(apply|destroy)\b|\bcdk\s+(deploy|destroy)\b|\b(serverless|sls)\s+(deploy|remove)\b|\bsam\s+(deploy|delete)\b/i, 'Infrastructure deploy or teardown'],
  [/\bkubectl\s+(apply|delete)\b|\bhelm\s+(install|upgrade|uninstall)\b|\beb\s+(deploy|terminate)\b|\b(vercel|netlify)\s+deploy\b/i, 'Deploys to a live environment'],
  [/\baws\s+iam\s+(create|delete|put|attach|detach|update)-/i, 'Changes AWS IAM (users, roles, policies or keys)'],
  [/\baws\s+secretsmanager\s+(put|delete|update)-|\baws\s+ssm\s+(put-parameter|delete-parameter)/i, 'Changes stored secrets or parameters in AWS'],
];

function highRisk(argv: string[]): string | undefined {
  const [prog = '', ...args] = argv;
  const words = args.filter((a) => !a.startsWith('-'));
  const has = (...xs: string[]) => words.some((w) => xs.includes(w));

  if (DB_CLIENTS.has(prog)) return `Database client (${prog}): connects to a database directly`;
  if (MIGRATION_TOOLS.has(prog)) return `Database migration (${prog})`;
  if (prog === 'prisma' && has('migrate', 'db')) return 'Database migration (prisma)';
  if (prog === 'knex' && words.some((w) => /^(migrate|seed)(:|$)/.test(w))) return 'Database migration (knex)';
  if ((prog === 'sequelize' || prog === 'sequelize-cli') && words.some((w) => w.startsWith('db:'))) return 'Database migration (sequelize)';
  if ((prog === 'rails' || prog === 'rake') && words.some((w) => w.startsWith('db:'))) return `Database task (${prog} db:)`;
  if (prog === 'typeorm' && words.some((w) => /^(migration|schema):/.test(w))) return 'Database migration (typeorm)';
  if (prog === 'drizzle-kit' && has('push', 'migrate', 'drop')) return 'Database migration (drizzle-kit)';
  if ((prog === 'django-admin' || prog === 'manage.py' || (/^python/.test(prog) && /manage\.py$/.test(args[0] ?? ''))) && has('migrate', 'flush', 'dbshell', 'loaddata', 'sqlflush')) {
    return 'Database migration (Django)';
  }
  if (prog === 'dotnet' && has('ef') && has('database')) return 'Database migration (dotnet ef)';

  if (['terraform', 'tofu', 'terragrunt'].includes(prog) && (has('apply', 'destroy', 'import', 'taint', 'untaint', 'force-unlock') || (has('state') && has('rm', 'mv', 'push')))) {
    return `Infrastructure change (${prog})`;
  }
  if ((prog === 'cdk' || prog === 'cdktf') && has('deploy', 'destroy', 'bootstrap')) return `Infrastructure deploy (${prog})`;
  if ((prog === 'serverless' || prog === 'sls') && has('deploy', 'remove', 'rollback')) return 'Deploy (serverless)';
  if (prog === 'sam' && has('deploy', 'delete', 'sync')) return 'Deploy (AWS SAM)';
  if (prog === 'kubectl' && has('apply', 'delete', 'create', 'replace', 'patch', 'scale', 'rollout', 'edit', 'set', 'drain', 'cordon', 'taint', 'label', 'annotate', 'exec', 'cp', 'run', 'expose', 'autoscale')) {
    return 'Changes a Kubernetes cluster (kubectl)';
  }
  if (prog === 'helm' && has('install', 'upgrade', 'uninstall', 'delete', 'rollback')) return 'Changes a Kubernetes cluster (helm)';
  if (prog === 'eb' && has('deploy', 'terminate', 'create', 'swap', 'scale', 'setenv', 'restore', 'abort')) return 'Deploy (Elastic Beanstalk)';
  if (prog === 'vercel' && (words.length === 0 || args.includes('--prod') || has('deploy', 'remove', 'rm', 'promote', 'rollback', 'redeploy', 'alias', 'env', 'domains', 'dns', 'certs'))) {
    return 'Deploy (Vercel)';
  }
  if (prog === 'netlify' && words.some((w) => /^(deploy|sites:delete|env:(set|unset|import|clone))$/.test(w))) return 'Deploy (Netlify)';
  if (prog === 'pulumi' && has('up', 'update', 'destroy', 'import', 'refresh', 'cancel')) return 'Infrastructure change (pulumi)';
  if (prog === 'firebase' && words.some((w) => w === 'deploy' || w === 'hosting:disable' || /:delete$/.test(w))) return 'Deploy (Firebase)';
  if ((prog === 'fly' || prog === 'flyctl') && has('deploy', 'destroy', 'secrets', 'scale', 'launch')) return 'Deploy (Fly.io)';
  if (prog === 'copilot' && has('deploy', 'delete')) return 'Deploy (AWS Copilot)';

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(prog)) {
    const script = words[0] === 'run' || words[0] === 'run-script' ? words[1] : prog !== 'npm' && prog !== 'bun' ? words[0] : undefined;
    if (script && RISKY_SCRIPT.test(script)) return `Runs the package script "${script}", which looks like a deploy or database change`;
  }

  if (prog === 'aws') {
    const k = classifyAws(argv);
    if (!k.read && k.highRisk) return k.reason;
  }
  return undefined;
}

// ---- AWS CLI ------------------------------------------------------------------------

const AWS_VALUE_OPTS = new Set([
  '--region', '--profile', '--output', '--endpoint-url', '--query', '--color', '--cli-read-timeout',
  '--cli-connect-timeout', '--ca-bundle', '--cli-binary-format',
]);
/** Read calls that still hand out secrets or credentials (get-secret-value, get-session-token, ...). */
const SENSITIVE_AWS_READ = /(secret|token|password|credential|login|session|federation|access-detail|access-key|decrypt|parameter|authorization|data-key|presign|private-key)/;

/**
 * Reads that return data or configuration rather than metadata: object and item contents,
 * function code and environment variables, task definitions (environment variables), templates.
 */
const AWS_DATA_READS = new Set([
  's3api get-object', 's3api get-object-torrent', 's3api get-object-attributes',
  'dynamodb get-item', 'dynamodb batch-get-item',
  'lambda get-function', 'lambda get-function-configuration', 'lambda get-layer-version',
  'ecs describe-task-definition', 'kinesis get-records', 'ec2 get-console-output', 'ec2 get-console-screenshot',
  'codecommit get-file', 'codecommit get-blob', 'cloudformation get-template', 'apigateway get-export',
  'glue get-connection', 'glue get-connections', 'rds download-db-log-file-portion',
]);

type AwsClass = { read: true } | { read: false; reason: string; highRisk: boolean };

export function classifyAws(argv: string[]): AwsClass {
  let i = 1;
  while (i < argv.length && argv[i]!.startsWith('-')) i += AWS_VALUE_OPTS.has(argv[i]!) ? 2 : 1;
  const svc = argv[i];
  const op = argv[i + 1];
  const args = argv.slice(i + 2);
  if (!svc || !op) return { read: false, reason: 'AWS CLI command', highRisk: false };
  if (svc === 'iam' && /^(create|delete|put|attach|detach|update|add|remove|set|change|reset|enable|deactivate|upload|tag|untag)-/.test(op)) {
    return { read: false, reason: `Changes AWS IAM (aws iam ${op})`, highRisk: true };
  }
  if (svc === 'secretsmanager' && /^(put|delete|update|create|restore|rotate|replicate|remove|cancel|tag|untag)-/.test(op)) {
    return { read: false, reason: `Changes a secret in AWS Secrets Manager (aws secretsmanager ${op})`, highRisk: true };
  }
  if (svc === 'ssm' && /^(put-parameter|delete-parameters?|label-parameter-version|unlabel-parameter-version)$/.test(op)) {
    return { read: false, reason: `Changes an AWS SSM parameter (aws ssm ${op})`, highRisk: true };
  }
  if (AWS_DATA_READS.has(`${svc} ${op}`)) {
    return { read: false, reason: `Reads data or configuration that may contain secrets (aws ${svc} ${op})`, highRisk: false };
  }
  const read =
    (/^(describe|list|get)-/.test(op) && !SENSITIVE_AWS_READ.test(op) && !args.some((a) => a.startsWith('--with-decryption'))) ||
    (svc === 'logs' && ['tail', 'filter-log-events', 'get-log-events'].includes(op)) ||
    (svc === 'sts' && op === 'get-caller-identity');
  return read ? { read: true } : { read: false, reason: `AWS CLI command that is not read-only (aws ${svc} ${op})`, highRisk: false };
}

// ---- Read-only allowlist for protected environments ---------------------------------

const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'wc', 'pwd', 'echo', 'printf', 'which', 'file', 'stat', 'du', 'df',
  'tree', 'diff', 'cmp', 'uniq', 'cut', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id', 'uname',
  'true', 'false', 'jq', 'nl', 'column', 'md5sum', 'sha1sum', 'sha256sum', 'test', '[',
]);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'describe', 'shortlog', 'cat-file']);
const GIT_BRANCH_LIST = new Set(['-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--show-current', '--verbose', '--merged', '--no-merged']);

function readOnlyProgram(argv: string[]): boolean {
  const [prog = '', ...args] = argv;
  switch (prog) {
    case 'git': {
      const sub = args[0] ?? '';
      if (args.some((a) => /^(--output|--ext-diff|-O|--open-files-in-pager)/.test(a))) return false;
      if (sub === 'branch') return args.slice(1).every((a) => GIT_BRANCH_LIST.has(a));
      return GIT_READ.has(sub);
    }
    case 'rg':
      return !args.some((a) => /^--pre(-glob)?(=|$)/.test(a));
    // Options that make an otherwise read-only program write files or run other programs.
    case 'sort':
      return !args.some((a) => /^-[a-zA-Z]*[oT]/.test(a) || /^--(output|compress-program|temporary-directory|random-source)/.test(a));
    case 'tree':
      return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith('--output'));
    case 'file':
      return !args.some((a) => /^-[a-zA-Z]*[Cm]/.test(a) || /^--(compile|magic-file)/.test(a));
    case 'date':
      return !args.some((a) => /^-[a-zA-Z]*s/.test(a) || a.startsWith('--set'));
    case 'uniq':
      // uniq INPUT OUTPUT writes the second file.
      return args.filter((a) => !a.startsWith('-')).length <= 1;
    case 'find':
      return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(a));
    case 'aws':
      return classifyAws(argv).read;
    // Test runners are deliberately not here: tests execute the repository's own code (and its
    // package scripts), which can do anything, so in protected environments they need approval.
    default:
      return READ_ONLY.has(prog);
  }
}

/**
 * Decides a shell command. Order: hard denials are checked by the caller; then high-risk
 * programs (approval everywhere), the destructive patterns, commands that compute what they
 * run, the AWS CLI, and finally, in protected environments, the read-only allowlist.
 */
export function decideCommand(command: string, ctx: PolicyContext = {}, dialect: 'bash' | 'powershell' = 'bash'): ToolDecision {
  const analysis = analyzeCommand(command, { dialect });
  const flat = flatten(command);

  for (const c of analysis.commands) {
    const reason = highRisk(c.argv);
    if (reason) return ask(reason);
  }
  for (const [re, reason] of HIGH_RISK_TEXT) if (re.test(flat)) return ask(reason);
  for (const [re, reason] of NEEDS_APPROVAL) if (re.test(command) || re.test(flat)) return ask(reason);
  if (analysis.dynamic) return ask('The command decides at run time what it runs, so the platform cannot check it');

  // Read-only AWS calls run without approval; anything else, or AWS used in a way the
  // parser did not follow (more mentions than parsed calls), waits for the developer.
  const awsCalls = analysis.commands.filter((c) => c.argv[0] === 'aws');
  for (const c of awsCalls) {
    const k = classifyAws(c.argv);
    if (!k.read) return ask(k.reason);
  }
  if ((flat.match(/\baws\s/gi)?.length ?? 0) > awsCalls.length) return ask('Cloud CLI command');

  if (ctx.protected || ctx.environmentKind === 'production') {
    const readOnly =
      analysis.commands.length > 0 &&
      !analysis.writes && !analysis.substitution && !analysis.heredoc &&
      analysis.commands.every((c) => !c.envPrefix && readOnlyProgram(c.argv));
    if (!readOnly) {
      const where = ctx.environmentKind === 'production' ? 'Production environment' : 'Protected environment';
      return ask(`${where}: only read-only commands (ls, cat, grep, git status/diff/log, read-only AWS) run without approval; tests run the repository's code, so they ask too`);
    }
  }
  return { action: 'allow' };
}

export function decideTool(
  repoRoot: string,
  toolName: string,
  input: Record<string, unknown>,
  blockedPath?: string,
  ctx: PolicyContext = {},
): ToolDecision {
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
    // Also checked with quotes and backslashes removed (`git p''ush`), except the
    // environment-dump rule, which would then match words inside quoted text.
    const flat = flatten(command);
    for (const [re, reason] of HARD_DENY) {
      if (re.test(command) || (re !== ENV_DUMP && re.test(flat))) return { action: 'deny', reason };
    }
    // The same rule on the parsed commands, which sees through quoting such as p'rint'env.
    if (analyzeCommand(command, { dialect: toolName === 'PowerShell' ? 'powershell' : 'bash' }).commands.some((c) => dumpsEnvironment(c.argv))) {
      return { action: 'deny', reason: 'Dumping environment variables is not allowed' };
    }
    return decideCommand(command, ctx, toolName === 'PowerShell' ? 'powershell' : 'bash');
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

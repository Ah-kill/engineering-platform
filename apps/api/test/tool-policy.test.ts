import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeCommand } from '../src/agents/command-parse.js';
import { classifyAws, decideTool, type PolicyContext } from '../src/agents/tool-policy.js';

/**
 * The shell side of the tool policy: high-risk commands (databases, migrations, deploys,
 * IAM and secret changes) always wait for approval, read-only AWS calls run freely outside
 * production, and protected environments only run a small read-only allowlist unattended.
 */

const repo = path.resolve('/work/ws/repo');
const DEV: PolicyContext = { environmentKind: 'development', protected: false };
const STAGING: PolicyContext = { environmentKind: 'staging', protected: false };
const PROD: PolicyContext = { environmentKind: 'production', protected: true };

const bash = (command: string, ctx: PolicyContext = DEV) => decideTool(repo, 'Bash', { command }, undefined, ctx);
const action = (command: string, ctx: PolicyContext = DEV) => bash(command, ctx).action;

function expectAll(commands: string[], expected: 'allow' | 'ask' | 'deny', ctx: PolicyContext = DEV) {
  for (const command of commands) expect(action(command, ctx), `${command} (${ctx.environmentKind})`).toBe(expected);
}

describe('command parsing', () => {
  const programs = (c: string) => analyzeCommand(c).commands.map((x) => x.argv[0]);

  it('splits on every command separator', () => {
    expect(programs('ls; psql && git status || echo x | grep y & wc -l\nnpm test')).toEqual(['ls', 'psql', 'git', 'echo', 'grep', 'wc', 'npm']);
    expect(programs('(cd a && make) |& tee log')).toEqual(['cd', 'make', 'tee']);
  });

  it('reads substitutions, shell -c strings and eval', () => {
    expect(programs('echo $(psql -c "select 1")')).toEqual(expect.arrayContaining(['echo', 'psql']));
    expect(programs('echo `mysql -e x`')).toEqual(expect.arrayContaining(['mysql']));
    expect(programs('echo "$(mongosh --eval 1)"')).toEqual(expect.arrayContaining(['mongosh']));
    expect(programs('bash -c "terraform apply -auto-approve"')).toEqual(['bash', 'terraform']);
    expect(programs("sh -lc 'cd infra; cdk deploy'")).toEqual(['sh', 'cd', 'cdk']);
    expect(programs('eval "kubectl apply -f x.yaml"')).toEqual(['eval', 'kubectl']);
    expect(programs('diff <(psql -c a) b')).toEqual(expect.arrayContaining(['psql', 'diff']));
  });

  it('strips paths, env prefixes and wrappers', () => {
    expect(analyzeCommand('PGPASSWORD=x /usr/bin/psql -h db').commands[0]).toMatchObject({ argv: ['psql', '-h', 'db'], envPrefix: true });
    expect(programs('env -i FOO=1 psql')).toEqual(['psql']);
    expect(programs('nohup timeout -s KILL 30 nice -n 5 terraform apply')).toEqual(['terraform']);
    expect(programs('xargs -I {} psql {}')).toEqual(['psql']);
    expect(programs('npx -y prisma@5 migrate deploy')).toEqual(['prisma']);
    expect(programs('bundle exec rails db:migrate')).toEqual(['rails']);
    expect(programs('python3 -m alembic upgrade head')).toEqual(['alembic']);
    // PowerShell: backslashes are path separators, the backtick escapes.
    expect(analyzeCommand('C:\\tools\\PSQL.EXE -c x', { dialect: 'powershell' }).commands[0]!.argv[0]).toBe('psql');
    expect(decideTool(repo, 'PowerShell', { command: 'C:\\tools\\PSQL.EXE -c x' }).action).toBe('ask');
    expect(analyzeCommand('p`sql', { dialect: 'powershell' }).commands[0]!.argv[0]).toBe('psql');
    expect(programs('find . -name "*.sql" -exec psql -f {} \\;')).toEqual(['find', 'psql']);
  });

  it('removes quotes and escapes the way the shell does', () => {
    expect(programs("ps''ql")).toEqual(['psql']);
    expect(programs('"psql" -c x')).toEqual(['psql']);
    expect(programs('p\\sql')).toEqual(['psql']);
    expect(programs('echo "a;b" \'c|d\'')).toEqual(['echo']);
  });

  it('flags programs computed at run time and file writes', () => {
    expect(analyzeCommand('$CMD -c x').dynamic).toBe(true);
    expect(analyzeCommand('x=psql; $x').dynamic).toBe(true);
    expect(analyzeCommand('$(which psql) -c x').dynamic).toBe(true);
    expect(analyzeCommand('/usr/bin/ps?l').dynamic).toBe(true);
    expect(analyzeCommand('echo "$HOME"').dynamic).toBe(false);
    expect(analyzeCommand('ls > out.txt').writes).toBe(true);
    expect(analyzeCommand('ls >> out.txt').writes).toBe(true);
    expect(analyzeCommand('ls &> out.txt').writes).toBe(true);
    expect(analyzeCommand('ls 2>/dev/null').writes).toBe(false);
    expect(analyzeCommand('ls 2>&1 | head').writes).toBe(false);
    expect(analyzeCommand('grep x < in.txt').writes).toBe(false);
  });
});

describe('high-risk commands ask in every environment', () => {
  const HIGH_RISK = [
    // database clients
    'psql -h db.internal -U app',
    'mysql -u root -e "DROP TABLE users"',
    'mongo mongodb://db/app',
    'mongosh "mongodb+srv://x"',
    'pg_dump app > dump.sql',
    'redis-cli FLUSHALL',
    // migrations
    'npx prisma migrate deploy',
    'prisma db push',
    'npx knex migrate:latest',
    'knex seed:run',
    'bin/rails db:migrate',
    'bundle exec rake db:drop',
    'alembic upgrade head',
    'python -m alembic downgrade -1',
    'flyway migrate',
    'liquibase update',
    'npx sequelize db:migrate',
    'npx sequelize-cli db:migrate:undo',
    'python manage.py migrate',
    'npx typeorm migration:run',
    'drizzle-kit push',
    'dotnet ef database update',
    // deploys
    'terraform apply -auto-approve',
    'terraform -chdir=infra destroy',
    'tofu apply',
    'cdk deploy --all',
    'npx cdk destroy MyStack',
    'serverless deploy --stage prod',
    'sls remove',
    'sam deploy --guided',
    'kubectl apply -f deploy.yaml',
    'kubectl -n prod delete pod x',
    'helm install app ./chart',
    'helm upgrade app ./chart',
    'helm uninstall app',
    'eb deploy production',
    'vercel deploy --prod',
    'vercel --prod',
    'vercel',
    'netlify deploy --prod',
    'pulumi up --yes',
    'firebase deploy',
    'fly deploy',
    'npm run deploy',
    'yarn db:reset',
    'pnpm run migrate',
    // IAM and secrets
    'aws iam create-user --user-name x',
    'aws iam attach-role-policy --role-name r --policy-arn arn',
    'aws iam put-user-policy --user-name x',
    'aws iam update-assume-role-policy --role-name r',
    'aws iam delete-role --role-name r',
    'aws iam detach-user-policy --user-name x',
    'aws secretsmanager put-secret-value --secret-id x',
    'aws secretsmanager delete-secret --secret-id x',
    'aws secretsmanager update-secret --secret-id x',
    'aws ssm put-parameter --name x --value y',
    'aws ssm delete-parameter --name x',
    'aws --profile prod --region us-east-1 iam create-access-key',
  ];

  it('in development, staging and production', () => {
    for (const ctx of [DEV, STAGING, PROD]) expectAll(HIGH_RISK, 'ask', ctx);
  });

  it('explains why in the approval reason', () => {
    expect(bash('psql -h db')).toEqual({ action: 'ask', reason: expect.stringMatching(/Database client/) });
    expect(bash('terraform apply')).toEqual({ action: 'ask', reason: expect.stringMatching(/Infrastructure change/) });
    expect(bash('aws iam create-user --user-name x')).toEqual({ action: 'ask', reason: expect.stringMatching(/IAM/) });
    expect(bash('npx prisma migrate deploy')).toEqual({ action: 'ask', reason: expect.stringMatching(/migration/i) });
    expect(bash('npm run deploy:prod')).toEqual({ action: 'ask', reason: expect.stringMatching(/package script "deploy:prod"/) });
  });

  it('cannot be slipped past by chaining, pipes, subshells or substitutions', () => {
    expectAll([
      'ls; psql -c "drop table x"',
      'ls && psql',
      'false || psql',
      'echo "select 1" | psql',
      'cat q.sql | mysql app',
      'ls & terraform apply',
      '(cd infra && terraform apply)',
      '{ terraform apply; }',
      'echo $(psql -c "select 1")',
      'echo `psql -c x`',
      'echo "$(kubectl delete ns prod)"',
      'diff <(psql -c a) b',
      'git status\npsql',
    ], 'ask');
  });

  it('cannot be slipped past with bash -c, eval or inline interpreters', () => {
    expectAll([
      'bash -c "psql -h db"',
      "sh -c 'terraform destroy -auto-approve'",
      'bash -lc "cdk deploy"',
      'zsh -c "helm upgrade x y"',
      'eval "psql"',
      'eval $CMD',
      'node -e "require(\'child_process\').execSync(\'psql -c 1\')"',
      'python3 -c "import os; os.system(\'mysql -e 1\')"',
    ], 'ask');
  });

  it('cannot be slipped past with env prefixes, wrappers or paths', () => {
    expectAll([
      'PGPASSWORD=secret psql -h db',
      'FOO=1 BAR=2 terraform apply',
      'env PGHOST=db psql',
      'env -- psql',
      '/usr/bin/psql -h db',
      '/usr/local/bin/terraform apply',
      './node_modules/.bin/prisma migrate deploy',
      'command psql',
      'exec psql',
      'nohup terraform apply &',
      'timeout 60 helm install x ./c',
      'xargs -n1 kubectl delete pod',
      'npx --yes knex migrate:latest',
      'pnpm exec prisma migrate reset',
      'pnpm dlx prisma db push',
      'npm exec -- sequelize db:migrate',
      'poetry run alembic upgrade head',
      'find . -name x -exec psql -f {} ;',
    ], 'ask');
  });

  it('cannot be slipped past with quoting, escapes, variables or globs', () => {
    expectAll([
      "ps''ql -h db",
      '"psql" -h db',
      'p\\sql -h db',
      "terra'form' apply",
      'x=psql; $x -h db',
      '$(which psql) -h db',
      '`echo psql` -h db',
      '/usr/bin/ps?l -h db',
      '/usr/bin/p[s]ql',
      "$'\\x70sql' -h db",
      '{psql,x}',
      'ps\\\nql -h db',
      '~/bin/psql',
      'exec -a innocent psql',
      'ls|psql',
      'ls&&psql',
      'psql<q.sql',
      'time psql',
    ], 'ask');
  });
});

describe('AWS CLI', () => {
  const READ_ONLY = [
    'aws ec2 describe-instances',
    'aws --region eu-west-1 ec2 describe-security-groups --output json',
    'aws s3api list-buckets',
    'aws lambda list-functions --max-items 5',
    'aws logs tail /aws/lambda/payments --follow',
    'aws logs filter-log-events --log-group-name g --filter-pattern ERROR',
    'aws logs get-log-events --log-group-name g --log-stream-name s',
    'aws sts get-caller-identity',
    'aws iam list-roles',
    'aws iam get-role --role-name r',
    'aws cloudformation describe-stacks | jq .Stacks[0].StackStatus',
  ];

  it('runs read-only calls without approval outside protected environments', () => {
    expectAll(READ_ONLY, 'allow', DEV);
    expectAll(READ_ONLY, 'allow', STAGING);
  });

  it('runs read-only calls in protected environments too (they are on the allowlist)', () => {
    expectAll(READ_ONLY, 'allow', PROD);
  });

  it('asks for anything else', () => {
    const others = [
      'aws s3 rm s3://x --recursive',
      'aws s3 cp file s3://bucket/',
      'aws s3 ls',
      'aws ec2 terminate-instances --instance-ids i-1',
      'aws lambda invoke --function-name x out.json',
      'aws configure list',
      'aws configure get aws_secret_access_key',
      'aws dynamodb delete-table --table-name t',
      'aws',
      'aws ec2',
    ];
    for (const ctx of [DEV, PROD]) expectAll(others, 'ask', ctx);
  });

  it('treats read calls that hand out secrets or credentials as not read-only', () => {
    expectAll([
      'aws secretsmanager get-secret-value --secret-id x',
      'aws ssm get-parameter --name x --with-decryption',
      'aws ssm get-parameters-by-path --path /app',
      'aws sts get-session-token',
      'aws ecr get-login-password',
      'aws ecr get-authorization-token',
      'aws ec2 get-password-data --instance-id i-1',
      'aws iam list-access-keys',
    ], 'ask');
  });

  it('does not let a read-only call carry a write along', () => {
    expectAll([
      'aws ec2 describe-instances; aws ec2 terminate-instances --instance-ids i-1',
      'aws ec2 describe-instances | xargs aws ec2 stop-instances --instance-ids',
      'aws sts get-caller-identity && bash -c "aws s3 rm s3://x"',
      'a=aws; $a s3 rm s3://x',
      'aws ec2 describe-instances --query "$(aws s3 rm s3://x)"',
    ], 'ask');
  });

  it('classifies calls', () => {
    expect(classifyAws(['aws', '--profile', 'p', 'ec2', 'describe-vpcs'])).toEqual({ read: true });
    expect(classifyAws(['aws', 'iam', 'create-role'])).toMatchObject({ read: false, highRisk: true });
    expect(classifyAws(['aws', 's3', 'sync', '.', 's3://b'])).toMatchObject({ read: false, highRisk: false });
  });
});

describe('protected environments', () => {
  it('run the read-only allowlist without approval', () => {
    expectAll([
      'ls -la',
      'cat README.md',
      'head -n 20 src/app.ts',
      'grep -rn "retry" src',
      'grep -r foo . 2>/dev/null',
      'rg TODO src',
      'find . -name "*.ts" -type f',
      'wc -l src/*.ts',
      'git status',
      'git diff HEAD~1 -- src',
      'git log --oneline -n 20',
      'git show HEAD:package.json',
      'git branch -a',
      'cat package.json | jq .scripts',
      'ls 2>&1 | head',
      'pwd && ls',
    ], 'allow', PROD);
  });

  it('ask for everything else', () => {
    const reason = bash('node scripts/fix.js', PROD);
    expect(reason).toEqual({ action: 'ask', reason: expect.stringMatching(/^Production environment: only read-only commands/) });
    expect(bash('node x.js', { environmentKind: 'staging', protected: true })).toEqual({ action: 'ask', reason: expect.stringMatching(/^Protected environment/) });
    expectAll([
      'node scripts/fix.js',
      'npm install',
      'npm run build',
      'touch a',
      'mkdir build',
      'cp a b',
      'mv a b',
      'sed -i s/a/b/ file',
      'awk "{print}" file',
      'ls > files.txt',
      'echo hi >> notes.md',
      'cat a | tee b',
      'ls; touch x',
      'echo $(whoami)',
      'GIT_PAGER=cat git log',
      'git -c core.pager=less log',
      'git diff --output=patch.diff',
      'git diff --ext-diff',
      'git commit -m x',
      'git checkout main',
      'git branch new-feature',
      'git stash',
      'rg --pre ./script.sh pattern',
      'find . -delete',
      'find . -exec cat {} ;',
      'sort -o out.txt in.txt',
      'npm test -- -u',
      'npx vitest',
      'bash -c "ls"',
      'make',
      'python script.py',
      'curl https://example.com',
      'cat <<EOF\nhello\nEOF',
    ], 'ask', PROD);
  });

  it('treat a production environment as protected even if it was unprotected', () => {
    expect(action('node x.js', { environmentKind: 'production', protected: false })).toBe('ask');
  });

  it('leave non-protected environments as before', () => {
    expectAll(['node scripts/fix.js', 'npm install', 'npm run build', 'touch a', 'ls > files.txt', 'echo $(date)', 'make'], 'allow', DEV);
  });
});

describe('existing rules still apply', () => {
  it('denies pushing and credential reads, including quoted spellings', () => {
    expectAll(['git push origin main', "git p''ush", 'git "push"', 'echo $ANTHROPIC_API_KEY', 'printenv', "su''do ls"], 'deny');
    expectAll(['git push origin main'], 'deny', PROD);
  });

  it('does not treat quoted words as an environment dump', () => {
    expect(action('git commit -m "fix env"')).not.toBe('deny');
  });

  it('asks before destructive commands and container tools', () => {
    expectAll(['rm -rf build', 'git reset --hard HEAD~1', 'docker run x', 'gcloud compute instances list'], 'ask');
  });

  it('keeps the default context for callers that pass none', () => {
    expect(decideTool(repo, 'Bash', { command: 'node x.js' })).toEqual({ action: 'allow' });
    expect(decideTool(repo, 'Bash', { command: 'aws ec2 describe-instances' })).toEqual({ action: 'allow' });
    expect(decideTool(repo, 'Bash', { command: 'psql' }).action).toBe('ask');
  });
});

describe('review fixes: allowlist escapes, env dumps, AWS data reads', () => {
  it('protected environments refuse options that make read-only programs run or write things', () => {
    expectAll(['sort --compress-program=sh file', 'sort -T /tmp a', 'sort -o out a', 'tree -o out.txt', 'file -C -m x', 'date -s "2020-01-01"', 'uniq in.txt out.txt'], 'ask', PROD);
    expectAll(['sort -r a.txt', 'tree -L 2', 'file package.json', 'date', 'uniq -c a.txt'], 'allow', PROD);
  });

  it('protected environments ask before running tests (they execute repository code)', () => {
    expectAll(['npm test', 'pnpm test', 'yarn test', 'npx vitest run', 'pytest', 'go test ./...', 'cargo test'], 'ask', PROD);
    expect(action('npm test', DEV)).toBe('allow');
  });

  it('environment dumps are denied even when disguised by quoting', () => {
    expectAll(["p'rint'env", 'pr""intenv', 'env', 'env -0', 'export', 'declare -x', 'set', 'cat /proc/self/environ', 'tr "\0" "\n" < /proc/1/environ'], 'deny');
    expect(action('env NODE_ENV=test npm test')).toBe('allow');
    expect(action('echo "set the value"')).toBe('allow');
  });

  it('AWS reads that return data, code or environment variables need approval', () => {
    for (const c of [
      'aws lambda get-function --function-name f',
      'aws lambda get-function-configuration --function-name f',
      'aws ecs describe-task-definition --task-definition t',
      'aws s3api get-object --bucket b --key k out.json',
      'aws dynamodb get-item --table-name t --key {}',
      'aws cloudformation get-template --stack-name s',
    ]) expect(action(c), c).toBe('ask');
    expect(classifyAws(['aws', 'lambda', 'list-functions']).read).toBe(true);
    expect(action('aws logs tail /aws/lambda/f')).toBe('allow');
  });
});

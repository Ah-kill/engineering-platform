import { useEffect, useState, type FormEvent } from 'react';
import { api, type EnvironmentRow } from '../api';
import { useAction, useResource } from '../hooks';

interface AwsConfig {
  roleArn: string | null;
  region: string | null;
  sessionSeconds: number;
  access: 'read' | 'write';
  externalIdSet: boolean;
  hint: string;
  /** Enforced with an STS session policy; null = the role's own permissions apply unchanged. */
  allowedActions: string[] | null;
  policyPreset: PresetId | 'custom' | null;
}

type PresetId = 'read-only' | 'deploy';
type PolicyMode = 'none' | PresetId | 'custom';

interface SessionPolicyPreset {
  id: PresetId;
  name: string;
  description: string;
  actions: string[];
}

interface PresetsResponse {
  presets: SessionPolicyPreset[];
  maxActions: number;
  maxPolicyChars: number;
}

/** Same rules as the API (src/aws/session-policy.ts); the API re-checks everything. */
const ACTION_RE = /^[a-z0-9-]+:[A-Za-z0-9*]+$/;
const DEFAULT_LIMITS = { maxActions: 100, maxPolicyChars: 2048 };

function parseActions(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean))];
}

function policySize(actions: string[]): number {
  return JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: actions, Resource: '*' }] }).length;
}

const ROLE_ARN_RE = /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
const EXTERNAL_ID_RE = /^[\w+=,.@:/-]{2,1224}$/;

const SESSION_OPTIONS = [
  [900, '15 minutes'],
  [1800, '30 minutes'],
  [3600, '1 hour'],
  [7200, '2 hours'],
  [14400, '4 hours'],
  [28800, '8 hours'],
  [43200, '12 hours'],
] as const;

function generateExternalId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `ep-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Per-environment AWS access: the client's IAM role the platform assumes with STS. Claude runs
 * and terminals in this environment get short-lived credentials for it; no AWS keys are stored.
 */
export function AwsCard({ environments, isOrgAdmin, onChanged }: { environments: EnvironmentRow[]; isOrgAdmin: boolean; onChanged?(): Promise<void> }) {
  const [envId, setEnvId] = useState(environments[0]?.id ?? '');
  useEffect(() => {
    if (!environments.some((e) => e.id === envId) && environments[0]) setEnvId(environments[0].id);
  }, [environments, envId]);
  const env = environments.find((e) => e.id === envId);
  const config = useResource<AwsConfig>(envId ? `/environments/${envId}/aws` : null);
  const presets = useResource<PresetsResponse>('/aws/session-policy-presets');
  const canEdit = !!env && env.permissions.includes('environment.manage') && (!env.protected || isOrgAdmin);
  const canUse = !!env && env.permissions.includes('environment.use');

  if (!environments.length) return null;

  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: 0 }}>AWS access</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          A role in the client's AWS account that this environment's workspaces use. Claude and the commands it runs get
          short-lived credentials for it (never long-lived keys), optionally narrowed to a list of allowed actions, and every
          use is recorded in the audit log.
        </div>
      </div>

      <div className="segmented" role="tablist" aria-label="Environment" style={{ flexWrap: 'wrap', maxWidth: '100%' }}>
        {environments.map((e) => (
          <button key={e.id} type="button" role="tab" aria-selected={e.id === envId} className={e.id === envId ? 'on' : ''} onClick={() => setEnvId(e.id)}>
            {e.name}{e.protected ? ' 🔒' : ''}
          </button>
        ))}
      </div>

      {env?.protected && !isOrgAdmin && env.permissions.includes('environment.manage') && (
        <div className="muted" style={{ fontSize: 13 }}>Only an org admin can change AWS access of a protected environment.</div>
      )}

      {config.error && <div className="error">{config.error.message}</div>}
      {config.data && env && (
        <AwsForm
          key={envId}
          envId={envId}
          env={env}
          config={config.data}
          canEdit={canEdit}
          canUse={canUse}
          presets={presets.data}
          onSaved={async () => { await config.reload(); await onChanged?.(); }}
        />
      )}

      <OnboardingHelp />
    </div>
  );
}

function AwsForm({ envId, env, config, canEdit, canUse, presets, onSaved }: {
  envId: string;
  env: EnvironmentRow;
  config: AwsConfig;
  canEdit: boolean;
  canUse: boolean;
  presets: PresetsResponse | undefined;
  onSaved(): Promise<void>;
}) {
  const [roleArn, setRoleArn] = useState(config.roleArn ?? '');
  const [externalId, setExternalId] = useState('');
  const [showExternalId, setShowExternalId] = useState(false);
  const [region, setRegion] = useState(config.region ?? env.awsRegion ?? '');
  const [sessionSeconds, setSessionSeconds] = useState(config.sessionSeconds);
  const [access, setAccess] = useState<'read' | 'write'>(config.access);
  const [policyMode, setPolicyMode] = useState<PolicyMode>(config.policyPreset ?? 'none');
  const [customText, setCustomText] = useState(config.policyPreset === 'custom' ? (config.allowedActions ?? []).join('\n') : '');
  const [saved, setSaved] = useState(false);
  const [test, setTest] = useState<{ account: string; arn: string } | null>(null);

  const limits = presets ?? DEFAULT_LIMITS;
  const presetById = (id: PolicyMode) => presets?.presets.find((p) => p.id === id);
  // undefined = keep what is stored (a preset was chosen but the preset list did not load)
  const allowedActions: string[] | null | undefined =
    policyMode === 'none' ? null : policyMode === 'custom' ? parseActions(customText) : presetById(policyMode)?.actions;
  const badActions = allowedActions ? allowedActions.filter((a) => !ACTION_RE.test(a)) : [];
  const policyChars = allowedActions ? policySize(allowedActions) : 0;
  const policyProblem = !allowedActions
    ? null
    : !allowedActions.length
      ? 'List at least one action, or choose "Use the role as-is".'
      : badActions.length
        ? `Not an AWS action: ${badActions.slice(0, 3).join(', ')}. Use service:Action, e.g. logs:FilterLogEvents or ec2:Describe*.`
        : allowedActions.length > limits.maxActions
          ? `At most ${limits.maxActions} actions.`
          : policyChars > limits.maxPolicyChars
            ? `Too large for AWS: ${policyChars} of ${limits.maxPolicyChars} characters. Remove actions or use wildcards such as lambda:Get*.`
            : null;

  const choosePolicy = (mode: PolicyMode) => {
    // Switching to Custom starts from the list that was selected, so a preset is easy to adjust.
    if (mode === 'custom' && policyMode !== 'custom' && !customText.trim()) {
      const from = policyMode === 'none' ? undefined : presetById(policyMode)?.actions;
      if (from) setCustomText(from.join('\n'));
    }
    setPolicyMode(mode);
    setSaved(false);
  };

  const save = useAction(async () => {
    await api('PUT', `/environments/${envId}/aws`, {
      roleArn: roleArn.trim(),
      region: region.trim(),
      sessionSeconds,
      access,
      ...(externalId.trim() ? { externalId: externalId.trim() } : {}),
      ...(allowedActions !== undefined ? { allowedActions } : {}),
    });
    setExternalId('');
    setShowExternalId(false);
    setSaved(true);
    await onSaved();
  });
  const remove = useAction(async () => {
    await api('DELETE', `/environments/${envId}/aws`);
    setRoleArn('');
    setExternalId('');
    setTest(null);
    await onSaved();
  });
  const testConnection = useAction(async () => {
    setTest(null);
    setTest(await api<{ account: string; arn: string }>('POST', `/environments/${envId}/aws/test`));
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSaved(false);
    void save.run();
  };

  const arnOk = ROLE_ARN_RE.test(roleArn.trim());
  const regionOk = REGION_RE.test(region.trim());
  const externalIdOk = externalId.trim() ? EXTERNAL_ID_RE.test(externalId.trim()) : config.externalIdSet;
  const sessionChoices = SESSION_OPTIONS.some(([s]) => s === sessionSeconds)
    ? SESSION_OPTIONS
    : [...SESSION_OPTIONS, [sessionSeconds, `${Math.round(sessionSeconds / 60)} minutes`] as const];

  return (
    <form className="form" onSubmit={submit}>
      {!config.roleArn && !canEdit && <p className="muted" style={{ margin: 0 }}>No AWS role is set up for {env.name}.</p>}

      {(config.roleArn || canEdit) && (
        <>
          <label>
            Role ARN
            <input className="mono" value={roleArn} readOnly={!canEdit} spellCheck={false} autoComplete="off"
              placeholder="arn:aws:iam::123456789012:role/EngineeringPlatformReadOnly"
              style={{ wordBreak: 'break-all' }}
              onChange={(e) => { setRoleArn(e.target.value); setSaved(false); }} />
          </label>
          {canEdit && roleArn && !arnOk && <div className="error">Paste the RoleArn from the client's stack outputs, e.g. arn:aws:iam::123456789012:role/EngineeringPlatformReadOnly</div>}

          <label>
            <span>
              External ID{' '}
              {config.externalIdSet
                ? <span className="badge ok" title="Encrypted; never shown again">set {config.hint}</span>
                : <span className="badge warn">not set</span>}
            </span>
            {canEdit ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input type={showExternalId ? 'text' : 'password'} className="mono" value={externalId} spellCheck={false} autoComplete="new-password"
                  placeholder={config.externalIdSet ? 'Leave blank to keep the saved one' : 'The ExternalId the client used'}
                  onChange={(e) => { setExternalId(e.target.value); setSaved(false); }} style={{ minWidth: 0 }} />
                <button type="button" className="small" title="Create a new random ExternalId to send to the client"
                  onClick={() => { setExternalId(generateExternalId()); setShowExternalId(true); setSaved(false); }}>Generate</button>
              </div>
            ) : (
              <input type="password" value={config.externalIdSet ? '••••••••' : ''} readOnly disabled />
            )}
          </label>
          {canEdit && showExternalId && externalId && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Copy this ExternalId now and send it to the client with the template. After saving it is stored encrypted and never shown again.
            </div>
          )}
          {canEdit && externalId.trim() && !EXTERNAL_ID_RE.test(externalId.trim()) && (
            <div className="error">2 to 1224 characters: letters, digits and + = , . @ : / - _</div>
          )}

          <div className="form-row">
            <label>
              Region
              <input className="mono" value={region} readOnly={!canEdit} spellCheck={false} placeholder="eu-west-1"
                onChange={(e) => { setRegion(e.target.value.toLowerCase()); setSaved(false); }} />
            </label>
            <label>
              Session length
              <select value={sessionSeconds} disabled={!canEdit} onChange={(e) => { setSessionSeconds(Number(e.target.value)); setSaved(false); }}>
                {sessionChoices.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
              </select>
            </label>
            <label>
              Access the client gave (label only)
              <select value={access} disabled={!canEdit} onChange={(e) => { setAccess(e.target.value as 'read' | 'write'); setSaved(false); }}>
                <option value="read">Read-only</option>
                <option value="write">Read and write</option>
              </select>
            </label>
          </div>
          {canEdit && region && !regionOk && <div className="error">Use a region code such as eu-west-1 or ap-south-1.</div>}
          {canEdit && sessionSeconds > 3600 && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Longer than 1 hour only works if the client raised the role's maximum session duration (MaxSessionHours in the template).
            </div>
          )}

          <PolicySection
            canEdit={canEdit}
            config={config}
            presets={presets}
            mode={policyMode}
            onMode={choosePolicy}
            customText={customText}
            onCustomText={(t) => { setCustomText(t); setSaved(false); }}
            actions={allowedActions}
            chars={policyChars}
            maxChars={limits.maxPolicyChars}
            problem={policyProblem}
          />
        </>
      )}

      {save.error && <div className="error">{save.error}</div>}
      {remove.error && <div className="error">{remove.error}</div>}
      {saved && !save.error && <div className="badge ok" style={{ justifySelf: 'start' }}>Saved. Applies from the next Claude run.</div>}

      <div className="form-row">
        {canEdit && (
          <button className="primary" disabled={save.pending || !arnOk || !regionOk || !externalIdOk || !!policyProblem}>Save AWS access</button>
        )}
        {config.roleArn && canUse && (
          <button type="button" disabled={testConnection.pending} onClick={() => void testConnection.run()}>
            {testConnection.pending ? 'Testing…' : 'Test connection'}
          </button>
        )}
        {config.roleArn && canEdit && (
          <button type="button" className="danger" disabled={remove.pending}
            onClick={() => { if (confirm(`Remove AWS access from ${env.name}? Running sessions keep their credentials until they expire.`)) void remove.run(); }}>
            Remove
          </button>
        )}
      </div>
      {config.roleArn && !canUse && (
        <div className="muted" style={{ fontSize: 12.5 }}>Testing the connection needs working access to {env.name}.</div>
      )}

      {testConnection.error && <div className="error">{testConnection.error}</div>}
      {test && (
        <div className="card" style={{ padding: 12 }}>
          <div><span className="badge ok">Connected</span></div>
          <div style={{ fontSize: 13, marginTop: 6 }}>Account <span className="mono">{test.account}</span></div>
          <div className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{test.arn}</div>
        </div>
      )}
    </form>
  );
}

const MODE_LABELS: Record<PolicyMode, string> = {
  none: 'Use the role as-is',
  'read-only': 'Read-only investigation',
  deploy: 'Deploy (Lambda + CloudFormation)',
  custom: 'Custom list',
};

/**
 * Enforced permissions. The platform passes these actions to AWS as a session policy when it
 * issues credentials; the session gets only what both the role and this list allow.
 */
function PolicySection({ canEdit, config, presets, mode, onMode, customText, onCustomText, actions, chars, maxChars, problem }: {
  canEdit: boolean;
  config: AwsConfig;
  presets: PresetsResponse | undefined;
  mode: PolicyMode;
  onMode(mode: PolicyMode): void;
  customText: string;
  onCustomText(text: string): void;
  actions: string[] | null | undefined;
  chars: number;
  maxChars: number;
  problem: string | null;
}) {
  const preset = presets?.presets.find((p) => p.id === mode);
  const shown = actions ?? (mode === 'none' ? null : config.allowedActions);
  return (
    <div className="stack" style={{ gap: 8 }}>
      <label>
        Enforced permissions
        <select value={mode} disabled={!canEdit} onChange={(e) => onMode(e.target.value as PolicyMode)}>
          {(['none', 'read-only', 'deploy', 'custom'] as const).map((m) => (
            <option key={m} value={m}>{presets?.presets.find((p) => p.id === m)?.name ?? MODE_LABELS[m]}</option>
          ))}
        </select>
      </label>
      <div className="muted" style={{ fontSize: 12.5 }}>
        {mode === 'none'
          ? "No session policy: credentials can do everything the client's role allows."
          : 'Credentials are limited to these actions with an AWS session policy. A session policy can only remove permissions; the role still sets the upper limit.'}
        {' '}"Access the client gave" is only a label. What is enforced is the role{mode === 'none' ? '' : ' narrowed by this list'}.
      </div>
      {preset && <div className="muted" style={{ fontSize: 12.5 }}>{preset.description}</div>}

      {mode === 'custom' && canEdit ? (
        <label>
          Allowed actions (one per line)
          <textarea className="mono" rows={8} value={customText} spellCheck={false}
            placeholder={'logs:FilterLogEvents\nlogs:Describe*\ncloudwatch:GetMetricData'}
            onChange={(e) => onCustomText(e.target.value)} />
        </label>
      ) : shown && shown.length > 0 ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>{shown.length} allowed actions</summary>
          <div className="mono" style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 6 }}>{shown.join('\n')}</div>
        </details>
      ) : null}

      {canEdit && actions && actions.length > 0 && (
        <div className="muted" style={{ fontSize: 12 }}>{actions.length} actions · {chars} of {maxChars} characters</div>
      )}
      {canEdit && problem && <div className="error">{problem}</div>}
      {mode === 'deploy' && (
        <div className="muted" style={{ fontSize: 12.5 }}>
          Write actions only work if the client's role allows them (the read-only template does not). Production changes still need an org admin here.
        </div>
      )}
    </div>
  );
}

function OnboardingHelp() {
  return (
    <details>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>How to connect a client's AWS account</summary>
      <ol className="muted" style={{ fontSize: 13, paddingLeft: 20, marginBottom: 0 }}>
        <li>Press <b>Generate</b> above to create an ExternalId for this client (or reuse the one you already gave them) and copy it.</li>
        <li>
          Send the client the read-only role template <code>infra/client-onboarding/readonly-role.yaml</code> with our platform AWS account ID
          and the ExternalId (see <code>docs/02-what-to-ask-clients.md</code>, section 2 "AWS access"). They deploy it as a CloudFormation stack in the
          account for this environment.
        </li>
        <li>
          Paste the <b>RoleArn</b> from the stack outputs here, choose the region and, if wanted, the <b>Enforced permissions</b> preset, then save.
          For agreed deployments, the draft <code>infra/client-onboarding/deploy-role.yaml</code> is a scoped write role.
        </li>
        <li>Press <b>Test connection</b>: it should show the client's account number.</li>
      </ol>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
        The role trusts only our account with that ExternalId; the client can delete it at any time to cut access. Use one role per environment.
      </div>
    </details>
  );
}

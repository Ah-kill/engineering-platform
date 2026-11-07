import { describe, expect, it } from 'vitest';
// The egress proxy is plain JS shipped inside the workspace image.
// @ts-expect-error untyped .mjs module
import { isAllowed, isPrivateAddress, parseRules, resolveTarget } from '../../runtime/egress-proxy.mjs';
import { parseDotEnv, validateName } from '../src/variables/variables.js';
import { HOST_RULE } from '../src/workspaces/runtime.js';
import { awsHostsFor } from '../src/aws/aws.js';
import { networkPolicyFor } from '../src/workspaces/service.js';

describe('variable names', () => {
  it('accepts conventional names and rejects reserved or malformed ones', () => {
    expect(validateName('PAYMENT_API_KEY')).toBe('PAYMENT_API_KEY');
    expect(validateName('_INTERNAL')).toBe('_INTERNAL');
    for (const bad of ['lowercase', '1ST', 'WITH-DASH', 'PATH', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'HTTPS_PROXY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GIT_DIR']) {
      expect(() => validateName(bad), bad).toThrow();
    }
  });
});

describe('.env import', () => {
  it('reads common .env syntax', () => {
    const text = [
      '# comment',
      'export API_BASE_URL=https://api.example.com',
      'SECRET_KEY="line1\\nline2"',
      "QUOTED='single # not a comment'",
      'PLAIN=value # trailing comment',
      'lower_case=x',
      '',
    ].join('\n');
    expect(parseDotEnv(text)).toEqual([
      { name: 'API_BASE_URL', value: 'https://api.example.com' },
      { name: 'SECRET_KEY', value: 'line1\nline2' },
      { name: 'QUOTED', value: 'single # not a comment' },
      { name: 'PLAIN', value: 'value' },
      { name: 'LOWER_CASE', value: 'x' },
    ]);
  });

  it('rejects lines it cannot read', () => {
    expect(() => parseDotEnv('this is not valid')).toThrow();
  });
});

describe('allowed host rules', () => {
  it('validates host entries', () => {
    for (const ok of ['api.example.com', '*.example.com', 'db.example.net:8443', 'sub.domain.co.uk']) expect(HOST_RULE.test(ok), ok).toBe(true);
    for (const bad of ['https://api.example.com', 'localhost', '10.0.0.1', 'example', '*.com', 'a..b.com', 'exa mple.com']) expect(HOST_RULE.test(bad), bad).toBe(false);
  });
});

describe('egress proxy decisions', () => {
  const rules = parseRules('api.example.com, *.example.org, db.example.net:8443');

  it('matches exact hosts, wildcard subdomains and explicit ports', () => {
    expect(isAllowed('api.example.com', 443, rules)).toBe(true);
    expect(isAllowed('API.EXAMPLE.COM', 80, rules)).toBe(true);
    expect(isAllowed('evil-api.example.com', 443, rules)).toBe(false);
    expect(isAllowed('x.example.org', 443, rules)).toBe(true);
    expect(isAllowed('example.org', 443, rules)).toBe(false); // wildcard means subdomains only
    expect(isAllowed('api.example.com', 22, rules)).toBe(false);
    expect(isAllowed('db.example.net', 8443, rules)).toBe(true);
    expect(isAllowed('db.example.net', 443, rules)).toBe(false);
  });

  it('recognises private, loopback and link-local addresses', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.10', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '104.18.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('refuses allowed names that resolve to private addresses (DNS rebinding to the host or LAN)', async () => {
    const lookup = async (host: string) => (host === 'api.example.com' ? [{ address: '192.168.1.5', family: 4 }] : [{ address: '93.184.216.34', family: 4 }]);
    expect(await resolveTarget('api.example.com', 443, rules, lookup)).toMatchObject({ error: expect.stringMatching(/private/) });
    expect(await resolveTarget('x.example.org', 443, rules, lookup)).toEqual({ address: '93.184.216.34' });
    expect(await resolveTarget('not-listed.com', 443, rules, lookup)).toMatchObject({ error: expect.stringMatching(/not in/) });
    expect(await resolveTarget('1.2.3.4', 443, parseRules('1.2.3.4'), lookup)).toMatchObject({ error: expect.any(String) });
  });
});

describe('workspace network policy', () => {
  it('adds region-scoped AWS endpoints only when a role is configured, never wildcards', () => {
    const base = { egressMode: 'restricted' as const, egressHosts: ['api.example.com'], awsRegion: 'eu-west-1', awsConfigured: false };
    expect(networkPolicyFor(base).hosts).toEqual(['api.example.com']);
    const withAws = networkPolicyFor({ ...base, awsConfigured: true }).hosts;
    expect(withAws).toEqual(expect.arrayContaining(['api.example.com', 'sts.amazonaws.com', 'sts.eu-west-1.amazonaws.com', 'logs.eu-west-1.amazonaws.com']));
    expect(withAws.some((h) => h.includes('*'))).toBe(false);
    expect(awsHostsFor('eu-west-1').some((h) => /^s3\.|execute-api|lambda-url/.test(h))).toBe(false);
  });
});

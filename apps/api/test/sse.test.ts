import { test, expect } from 'vitest';
import { Client, seedOrg, setup } from './helpers.js';

test('the event stream replays every event of a conversation in order (regression: ids sorted as text)', async () => {
  const env = await setup();
  const { adminEmail, orgId } = await seedOrg(env.db, 'acme');
  const admin = await Client.login(env.app, adminEmail);
  const [u] = await env.db.system((q) => q.query<{ id: string }>('SELECT id FROM users'));
  const ids = await env.db.system(async (q) => {
    const [c] = await q.query<{ id: string }>(`INSERT INTO clients (org_id, name, slug) VALUES ($1,'c','c') RETURNING id`, [orgId]);
    const [a] = await q.query<{ id: string }>(`INSERT INTO applications (org_id, client_id, name, slug) VALUES ($1,$2,'a','a') RETURNING id`, [orgId, c!.id]);
    const [e] = await q.query<{ id: string }>(`INSERT INTO environments (org_id, application_id, name, kind) VALUES ($1,$2,'development','development') RETURNING id`, [orgId, a!.id]);
    const [r] = await q.query<{ id: string }>(`INSERT INTO repositories (org_id, application_id, provider, owner, name) VALUES ($1,$2,'github','o','n') RETURNING id`, [orgId, a!.id]);
    const [w] = await q.query<{ id: string }>(`INSERT INTO workspaces (org_id, application_id, environment_id, repository_id, owner_id, branch, base_branch, state) VALUES ($1,$2,$3,$4,$5,'b','main','ready') RETURNING id`, [orgId, a!.id, e!.id, r!.id, u!.id]);
    await q.query(`INSERT INTO grants (org_id, user_id, role, scope_type, scope_id) VALUES ($1,$2,'developer','application',$3)`, [orgId, u!.id, a!.id]);
    const [s] = await q.query<{ id: string }>(`INSERT INTO agent_sessions (org_id, workspace_id, user_id, model, auth_mode, title) VALUES ($1,$2,$3,'default','api_key','t') RETURNING id`, [orgId, w!.id, u!.id]);
    for (const kind of ['user','status','text','tool_use','tool_result','plan','status','user','status','tool_use','tool_result','text','result','status']) {
      await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1,$2,$3,'{"x":1}')`, [orgId, s!.id, kind]);
    }
    return { s: s!.id };
  });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (env.app.server.address() as { port: number }).port;
  const cookie = (admin as unknown as { cookie: string }).cookie;
  const res = await fetch(`http://127.0.0.1:${port}/api/agent/sessions/${ids.s}/events?after=0`, { headers: { cookie } });
  const reader = res.body!.getReader();
  let text = '';
  const end = Date.now() + 1500;
  while (Date.now() < end) {
    const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), 300))]);
    if (r.value) text += new TextDecoder().decode(r.value);
    if (r.done) break;
  }
  const kinds = [...text.matchAll(/"kind":"([a-z_]+)"/g)].map((m) => m[1]);
  expect(res.status).toBe(200);
  expect(kinds).toEqual(['user','status','text','tool_use','tool_result','plan','status','user','status','tool_use','tool_result','text','result','status']);
  await reader.cancel();
  await env.close();
});

import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../access/authorize.js';
import { caller, type RouteDeps } from '../http/app.js';
import { principalOf } from '../identity/user-routes.js';
import { audit } from './audit.js';
import { AUDIT_COLUMNS, AUDIT_FROM, auditWhere, CSV_HEADER, csvLine, exportQuery, listQuery, type AuditFilters, type AuditRow } from './query.js';

/** Rows read per transaction while streaming an export. */
const EXPORT_BATCH = 1000;

export async function auditRoutes(app: FastifyInstance, { db }: RouteDeps) {
  /**
   * The audit log, newest first. Org admins only (`org.read_audit`).
   * Filters: clientId, applicationId, environmentId, workspaceId, actorId, action (prefix),
   * outcome, from/to (inclusive; plain dates are UTC days); `before` + `limit` paginate.
   */
  app.get('/audit', async (req) => {
    const { user } = caller(req);
    const f = listQuery.parse(req.query);
    return db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.read_audit', { type: 'org' });
      const where = auditWhere(f);
      return q.query<AuditRow>(
        `SELECT ${AUDIT_COLUMNS} FROM ${AUDIT_FROM}
          WHERE ${where.sql}
          ORDER BY ae.id DESC
          LIMIT $${where.params.length + 1}`,
        [...where.params, f.limit],
      );
    });
  });

  /**
   * The same filters as a CSV download (newest first, at most 50,000 rows). Rows are read in
   * batches and streamed, so a large export never sits in memory. The export is itself audited.
   */
  app.get('/audit/export.csv', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { user } = caller(req);
    const { limit, ...filters } = exportQuery.parse(req.query);

    // Permission check, a fixed upper id (events recorded during the export are left out) and
    // the audit record, all before the first byte is sent, so a refusal is a normal JSON error.
    const upper = await db.tenant(user.orgId, async (q) => {
      await requirePermission(q, principalOf(user), 'org.read_audit', { type: 'org' });
      const [row] = await q.query<{ max: string | null }>('SELECT max(id)::text AS max FROM audit_events');
      const { fromTs, toTs, ...rest } = filters;
      await audit(q, {
        orgId: user.orgId, actorId: user.id, action: 'audit.exported',
        details: { filters: { ...rest, from: fromTs?.toISOString(), to: toTs?.toISOString() }, limit },
      });
      return row?.max ? Number(row.max) : 0;
    });

    async function* lines(): AsyncGenerator<string> {
      yield '﻿' + CSV_HEADER.join(',') + '\r\n'; // the byte-order mark makes Excel read UTF-8
      let cursor = Math.min(upper + 1, filters.before ?? Number.MAX_SAFE_INTEGER);
      let sent = 0;
      while (sent < limit) {
        const want = Math.min(EXPORT_BATCH, limit - sent);
        const where = auditWhere({ ...filters, before: cursor } satisfies AuditFilters);
        const rows = await db.tenant(user.orgId, (q) =>
          q.query<AuditRow>(
            `SELECT ${AUDIT_COLUMNS} FROM ${AUDIT_FROM}
              WHERE ${where.sql}
              ORDER BY ae.id DESC
              LIMIT $${where.params.length + 1}`,
            [...where.params, want],
          ),
        );
        if (rows.length) yield rows.map(csvLine).join('');
        sent += rows.length;
        if (rows.length < want) return;
        cursor = Number(rows[rows.length - 1]!.id);
      }
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const stream = Readable.from(lines());
    stream.on('error', (err) => req.log.error({ err }, 'audit export failed'));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-${stamp}.csv"`)
      .header('cache-control', 'no-store')
      .send(stream);
  });
}

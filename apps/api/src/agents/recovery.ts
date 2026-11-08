import type { Database } from '../db/db.js';

export const INTERRUPTED_MESSAGE = 'The run was interrupted by a server restart.';

/**
 * Closes off conversations whose last status is still `running` from before a restart.
 * Runs live only in this process, so at startup nothing can still be working: without
 * this, the chat would show those conversations as running forever and lock its input.
 * Appends an `error` event and then `status: idle` to each, and returns how many there were.
 *
 * Call once at startup, before the server accepts requests. Uses `db.system` because it
 * spans every organisation.
 */
export async function recoverInterruptedRuns(db: Database): Promise<number> {
  return db.system(async (q) => {
    const stuck = await q.query<{ session_id: string; org_id: string }>(
      `SELECT session_id, org_id FROM (
         SELECT DISTINCT ON (e.session_id) e.session_id, e.org_id, e.data->>'state' AS state
           FROM agent_events e
          WHERE e.kind = 'status'
          ORDER BY e.session_id, e.id DESC
       ) latest
        WHERE state = 'running'`,
    );
    for (const s of stuck) {
      await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1, $2, 'error', $3)`, [
        s.org_id, s.session_id, JSON.stringify({ message: INTERRUPTED_MESSAGE, reason: 'restart' }),
      ]);
      await q.query(`INSERT INTO agent_events (org_id, session_id, kind, data) VALUES ($1, $2, 'status', $3)`, [
        s.org_id, s.session_id, JSON.stringify({ state: 'idle' }),
      ]);
    }
    return stuck.length;
  });
}

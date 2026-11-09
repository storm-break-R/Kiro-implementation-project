import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/common.js';
import { audit } from '../services/audit.js';
import { rankedResults } from '../services/history.js';
import type { ResultsService } from '../services/results.js';
import { csvCell } from '../utils/csv.js';
import { AppError } from '../utils/errors.js';
import { idParams } from '../utils/validation.js';
import { actorOf } from './adminEvents.js';

const exportQuery = z.object({ format: z.enum(['csv', 'json']).default('csv') });

const row = (cells: unknown[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** Mounted at /events behind authenticate + requireRole('admin'). */
export function createAdminExportRouter(results: ResultsService): Router {
  const router = Router();

  router.get('/:id/export', validate(idParams, 'params'), validate(exportQuery, 'query'), async (req, res) => {
    const id = req.params.id as string;
    const { format } = req.query as unknown as z.infer<typeof exportQuery>;
    const snap = await results.snapshot(id, { includeHidden: true });
    if (!snap.final) throw AppError.conflict('Results can be exported once voting has closed');

    // Audit before disclosing: if the log write fails, no data leaves the server.
    const actor = actorOf(req);
    await audit({
      action: 'results.exported',
      actorId: actor.id,
      actorRole: actor.role,
      ip: actor.ip,
      target: `event:${id}`,
      meta: { format },
    });

    const ranked = rankedResults(snap);
    const exportedAt = new Date().toISOString();
    const base = `results-${id}-${exportedAt.slice(0, 10)}`;
    res.setHeader('Cache-Control', 'no-store');

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
      res.json({
        event: { id, title: snap.title, status: snap.status, endsAt: snap.endsAt },
        exportedAt,
        totalVotes: snap.totalVotes,
        turnout: snap.turnout,
        results: ranked,
      });
    } else {
      // Streamed line by line, so a large export never builds one big string.
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${base}.csv"`);
      res.write(row(['rank', 'candidate', 'team', 'votes', 'percent']));
      for (const r of ranked) res.write(row([r.rank, r.name, r.team, r.votes, r.percent]));
      res.write('\r\n');
      res.write(row(['summary', 'value']));
      res.write(row(['event', snap.title]));
      res.write(row(['total votes', snap.totalVotes]));
      res.write(row(['eligible voters', snap.turnout.eligible]));
      res.write(row(['registered voters', snap.turnout.registered]));
      res.write(row(['turnout percent', snap.turnout.percent]));
      res.write(row(['exported at', exportedAt]));
      res.end();
    }
  });

  return router;
}

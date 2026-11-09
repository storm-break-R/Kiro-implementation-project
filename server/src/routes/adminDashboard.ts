import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/common.js';
import { AuditLog } from '../models/auditLog.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import { VotingEvent } from '../models/event.js';
import { Participation } from '../models/voting.js';
import { audit, verifyAuditChain } from '../services/audit.js';
import { toEventDto } from '../services/events.js';
import { actorOf } from './adminEvents.js';

const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z
    .string()
    .trim()
    .regex(/^[a-z_.]{1,60}$/, 'letters, dots and underscores only')
    .optional(),
});

/** Mounted behind authenticate + requireRole('admin'). */
export function createAdminDashboardRouter(): Router {
  const router = Router();

  // Turnout overview for every event (newest first).
  router.get('/dashboard', async (_req, res) => {
    const events = await VotingEvent.find().sort({ createdAt: -1 }).limit(100);
    const rows = await Promise.all(
      events.map(async (e) => {
        const [eligible, registered, voted] = await Promise.all([
          EligibleVoter.countDocuments({ eventId: e._id }),
          EligibleVoter.countDocuments({ eventId: e._id, userId: { $exists: true } }),
          Participation.countDocuments({ eventId: e._id }),
        ]);
        return {
          ...toEventDto(e),
          turnout: {
            eligible,
            registered,
            voted,
            remaining: Math.max(registered - voted, 0),
            percent: eligible ? Math.round((voted / eligible) * 1000) / 10 : 0,
          },
        };
      }),
    );
    const sum = (k: 'eligible' | 'registered' | 'voted') => rows.reduce((n, r) => n + r.turnout[k], 0);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      totals: {
        events: rows.length,
        open: rows.filter((r) => r.status === 'open').length,
        eligible: sum('eligible'),
        registered: sum('registered'),
        voted: sum('voted'),
      },
      events: rows,
    });
  });

  router.get('/audit', validate(auditQuery, 'query'), async (req, res) => {
    const q = req.query as unknown as z.infer<typeof auditQuery>;
    const filter = q.action ? { action: { $regex: `^${q.action.replace(/\./g, '\\.')}` } } : {};
    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ seq: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);
    res.json({
      total,
      page: q.page,
      limit: q.limit,
      entries: entries.map((e) => ({
        seq: e.seq,
        ts: e.ts.toISOString(),
        action: e.action,
        actorId: e.actorId ?? null,
        actorRole: e.actorRole ?? null,
        target: e.target ?? null,
        ip: e.ip ?? null,
        meta: e.meta ?? {},
        hash: e.hash,
      })),
    });
  });

  router.get('/audit/verify', async (req, res) => {
    const result = await verifyAuditChain();
    await audit({ action: 'audit.verified', ...toAuditActor(actorOf(req)), meta: { ...result } });
    res.json(result);
  });

  return router;
}

function toAuditActor(actor: ReturnType<typeof actorOf>) {
  return { actorId: actor.id, actorRole: actor.role, ip: actor.ip };
}

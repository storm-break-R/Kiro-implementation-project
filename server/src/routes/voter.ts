import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/common.js';
import { EligibleVoter } from '../models/eligibleVoter.js';
import type { VotingService } from '../services/voting.js';
import { idParams, objectIdSchema } from '../utils/validation.js';
import { VotingEvent } from '../models/event.js';
import { User } from '../models/user.js';
import { Participation } from '../models/voting.js';
import { toEventDto } from '../services/events.js';
import { AppError } from '../utils/errors.js';

/** Mounted behind authenticate + requireRole('voter'). */
const voteBody = z.object({ candidateId: objectIdSchema });

export function createVoterRouter(voting: VotingService, voteLimiter: RequestHandler): Router {
  const router = Router();

  router.post(
    '/events/:id/vote',
    voteLimiter,
    validate(idParams, 'params'),
    validate(voteBody),
    async (req, res) => {
      await voting.cast(req.user!.id, req.params.id as string, req.body.candidateId, { ip: req.ip });
      // Intentionally does not echo the choice back.
      res.status(201).json({ ok: true });
    },
  );

  // The events this voter is registered for, and whether they have already voted in each.
  router.get('/events', async (req, res) => {
    const user = await User.findById(req.user!.id).lean();
    if (!user) throw AppError.unauthorized();
    const rows = await EligibleVoter.find({ _id: { $in: user.eligibleVoterIds } }, { eventId: 1 }).lean();
    const eventIds = rows.map((r) => r.eventId);
    const [events, participations] = await Promise.all([
      VotingEvent.find({ _id: { $in: eventIds }, status: { $ne: 'draft' } }).sort({ startsAt: -1 }),
      Participation.find({ userId: user._id, eventId: { $in: eventIds } }, { eventId: 1 }).lean(),
    ]);
    const voted = new Set(participations.map((p) => p.eventId.toString()));
    res.json({
      events: events.map((e) => ({ ...toEventDto(e), hasVoted: voted.has(e._id.toString()) })),
    });
  });

  return router;
}

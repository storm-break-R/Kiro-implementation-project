import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { MAX_IMAGE_BYTES } from '../infra/storage.js';
import { validate } from '../middleware/common.js';
import { RESULTS_VISIBILITY, VotingEvent } from '../models/event.js';
import { EventService, toCandidateDto, toEventDto, type Actor } from '../services/events.js';
import type { ResultsService } from '../services/results.js';
import { idAndCandidateParams, idParams } from '../utils/validation.js';

const eventFields = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).default(''),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  resultsVisibility: z.enum(RESULTS_VISIBILITY).default('live'),
});
const createEventBody = eventFields.refine((v) => v.endsAt > v.startsAt, {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
});
const updateEventBody = eventFields.partial().omit({ description: true }).extend({
  description: z.string().trim().max(2000).optional(),
});

const text = (max: number) => z.string().trim().max(max);
const createCandidateBody = z.object({
  name: z.string().trim().min(1).max(120),
  team: text(120).default(''),
  bio: text(1000).default(''),
});
const updateCandidateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  team: text(120).optional(),
  bio: text(1000).optional(),
  removeImage: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10 },
});

export function actorOf(req: Express.Request & { user?: { id: string }; ip?: string }): Actor {
  return { id: req.user!.id, role: 'admin', ip: req.ip };
}

/** Mounted behind authenticate + requireRole('admin'). */
export function createAdminEventsRouter(events: EventService, results: ResultsService): Router {
  const router = Router();

  // Admins can monitor counts even for events that hide results from the public until close.
  router.get('/:id/results', validate(idParams, 'params'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await results.snapshot(req.params.id as string, { includeHidden: true }));
  });

  router.get('/', async (_req, res) => {
    const list = await VotingEvent.find().sort({ createdAt: -1 });
    res.json({ events: list.map((e) => toEventDto(e)) });
  });

  router.post('/', validate(createEventBody), async (req, res) => {
    const event = await events.create(req.body, actorOf(req));
    res.status(201).json(toEventDto(event));
  });

  router.get('/:id', validate(idParams, 'params'), async (req, res) => {
    const event = await events.getEventOrThrow(req.params.id as string);
    const candidates = await events.listCandidates(event._id);
    res.json({ ...toEventDto(event), candidates: candidates.map(toCandidateDto) });
  });

  router.patch('/:id', validate(idParams, 'params'), validate(updateEventBody), async (req, res) => {
    const event = await events.update(req.params.id as string, req.body, actorOf(req));
    res.json(toEventDto(event));
  });

  router.delete('/:id', validate(idParams, 'params'), async (req, res) => {
    await events.remove(req.params.id as string, actorOf(req));
    res.status(204).end();
  });

  router.post('/:id/open', validate(idParams, 'params'), async (req, res) => {
    res.json(toEventDto(await events.open(req.params.id as string, actorOf(req))));
  });

  router.post('/:id/close', validate(idParams, 'params'), async (req, res) => {
    res.json(toEventDto(await events.close(req.params.id as string, actorOf(req))));
  });

  // --- candidates (multipart so an image can be attached) ---

  router.post(
    '/:id/candidates',
    validate(idParams, 'params'),
    upload.single('image'),
    validate(createCandidateBody),
    async (req, res) => {
      const candidate = await events.addCandidate(req.params.id as string, req.body, req.file, actorOf(req));
      res.status(201).json(toCandidateDto(candidate));
    },
  );

  router.patch(
    '/:id/candidates/:candidateId',
    validate(idAndCandidateParams, 'params'),
    upload.single('image'),
    validate(updateCandidateBody),
    async (req, res) => {
      const p = req.params as { id: string; candidateId: string };
      const candidate = await events.updateCandidate(p.id, p.candidateId, req.body, req.file, actorOf(req));
      res.json(toCandidateDto(candidate));
    },
  );

  router.delete(
    '/:id/candidates/:candidateId',
    validate(idAndCandidateParams, 'params'),
    async (req, res) => {
      const p = req.params as { id: string; candidateId: string };
      await events.removeCandidate(p.id, p.candidateId, actorOf(req));
      res.status(204).end();
    },
  );

  return router;
}

import { Router } from 'express';
import { VotingEvent } from '../models/event.js';
import type { ImageStorage } from '../infra/storage.js';
import { IMAGE_KEY_PATTERN } from '../infra/storage.js';
import { validate } from '../middleware/common.js';
import { EventService, toCandidateDto, toEventDto } from '../services/events.js';
import type { ResultsService } from '../services/results.js';
import type { HistoryService } from '../services/history.js';
import { AppError } from '../utils/errors.js';
import { idParams } from '../utils/validation.js';

/** Read-only endpoints open to everyone (drafts are never exposed). */
export function createPublicEventsRouter(
  events: EventService,
  results: ResultsService,
  history: HistoryService,
): Router {
  const router = Router();

  // Must come before /:id.
  router.get('/history', async (_req, res) => {
    res.json({ events: await history.closedEvents() });
  });

  router.get('/:id/timeline', validate(idParams, 'params'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await history.timeline(req.params.id as string));
  });

  // Initial snapshot for the live results page (later updates arrive over socket.io).
  router.get('/:id/results', validate(idParams, 'params'), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await results.snapshot(req.params.id as string));
  });

  router.get('/', async (_req, res) => {
    const list = await VotingEvent.find({ status: { $ne: 'draft' } }).sort({ startsAt: -1 });
    res.json({ events: list.map((e) => toEventDto(e)) });
  });

  router.get('/:id', validate(idParams, 'params'), async (req, res) => {
    const event = await events.getEventOrThrow(req.params.id as string);
    if (event.status === 'draft') throw AppError.notFound('Event not found');
    const candidates = await events.listCandidates(event._id);
    res.json({ ...toEventDto(event), candidates: candidates.map(toCandidateDto) });
  });

  return router;
}

/** Streams candidate images from whichever storage backend is configured. */
export function createImagesRouter(storage: ImageStorage): Router {
  const router = Router();

  router.get('/candidates/:file', async (req, res) => {
    const key = `candidates/${req.params.file}`;
    if (!IMAGE_KEY_PATTERN.test(key)) throw AppError.notFound();
    const object = await storage.get(key);
    if (!object) throw AppError.notFound();
    res.setHeader('Content-Type', object.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    // helmet defaults to same-origin; images are meant to be embeddable by the SPA origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(object.body);
  });

  return router;
}

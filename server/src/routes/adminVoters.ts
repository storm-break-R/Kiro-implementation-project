import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { validate } from '../middleware/common.js';
import { VoterService, MAX_CSV_BYTES, type IssuedCode } from '../services/voters.js';
import { toCsv } from '../utils/csv.js';
import { AppError } from '../utils/errors.js';
import { objectIdSchema } from '../utils/validation.js';
import { actorOf } from './adminEvents.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 5 },
});

const eventParams = z.object({ id: objectIdSchema });
const voterParams = z.object({ id: objectIdSchema, voterId: objectIdSchema });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(100).optional(),
});
const generateQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });

function sendCodes(
  res: import('express').Response,
  eventId: string,
  codes: IssuedCode[],
  format: 'json' | 'csv',
) {
  // Plaintext codes exist only in this response. Make sure nothing caches it.
  res.setHeader('Cache-Control', 'no-store');
  if (format === 'csv') {
    const csv = toCsv(
      ['name', 'email', 'nationalIdLast4', 'verificationCode'],
      codes.map((c) => [c.fullName, c.email, c.nationalIdLast4, c.code]),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="voter-codes-${eventId}.csv"`);
    res.send(csv);
    return;
  }
  res.json({ generated: codes.length, codes });
}

/** Mounted at /events/:id behind authenticate + requireRole('admin'). */
export function createAdminVotersRouter(voters: VoterService): Router {
  const router = Router({ mergeParams: true });

  router.get('/voters', validate(eventParams, 'params'), validate(listQuery, 'query'), async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuery>;
    res.json(await voters.list(req.params.id as string, query));
  });

  router.post('/voters/import', validate(eventParams, 'params'), upload.single('file'), async (req, res) => {
    if (!req.file) throw AppError.badRequest('Attach a CSV file in the "file" field');
    const result = await voters.importCsv(req.params.id as string, req.file.buffer, actorOf(req));
    res.status(result.imported > 0 ? 201 : 200).json(result);
  });

  router.delete('/voters/:voterId', validate(voterParams, 'params'), async (req, res) => {
    const p = req.params as { id: string; voterId: string };
    await voters.remove(p.id, p.voterId, actorOf(req));
    res.status(204).end();
  });

  router.post(
    '/codes/generate',
    validate(eventParams, 'params'),
    validate(generateQuery, 'query'),
    async (req, res) => {
      const id = req.params.id as string;
      const { format } = req.query as unknown as z.infer<typeof generateQuery>;
      sendCodes(res, id, await voters.generateMissingCodes(id, actorOf(req)), format);
    },
  );

  router.post(
    '/voters/:voterId/code',
    validate(voterParams, 'params'),
    validate(generateQuery, 'query'),
    async (req, res) => {
      const p = req.params as { id: string; voterId: string };
      const { format } = req.query as unknown as z.infer<typeof generateQuery>;
      sendCodes(res, p.id, [await voters.regenerateCode(p.id, p.voterId, actorOf(req))], format);
    },
  );

  return router;
}

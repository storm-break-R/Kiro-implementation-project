import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodType } from 'zod';
import { AppError } from '../utils/errors.js';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
};

type Source = 'body' | 'query' | 'params';

/** Validate (and replace) req.body / req.query / req.params with the parsed zod result. */
export function validate(schema: ZodType, source: Source = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        new AppError(400, 'VALIDATION_ERROR', 'Invalid request', formatZodIssues(result.error)),
      );
      return;
    }
    if (source === 'body') {
      req.body = result.data;
    } else {
      // Express 5 exposes query/params as getters, so shadow them on the instance.
      Object.defineProperty(req, source, { value: result.data, configurable: true });
    }
    next();
  };
}

function formatZodIssues(error: ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId: req.id },
    });
    return;
  }
  if (err?.name === 'MulterError') {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({
      error: {
        code: tooBig ? 'IMAGE_TOO_LARGE' : 'BAD_UPLOAD',
        message: tooBig ? 'Image must be 2 MB or smaller' : 'Invalid upload',
        requestId: req.id,
      },
    });
    return;
  }
  // Body parser style errors carry a status.
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({
      error: { code: 'BAD_REQUEST', message: 'Malformed request', requestId: req.id },
    });
    return;
  }
  // Never leak internals; log without request bodies (may contain secrets or ballot choices).
  console.error(`[${req.id}] Unhandled error:`, err instanceof Error ? err.message : err);
  res.status(500).json({
    error: { code: 'INTERNAL', message: 'Something went wrong', requestId: req.id },
  });
};

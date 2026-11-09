import type { RequestHandler } from 'express';
import type { Role } from '../models/user.js';
import type { SessionService } from '../services/sessions.js';
import { AppError } from '../utils/errors.js';

export interface AuthUser {
  id: string;
  role: Role;
  mfa: boolean;
  sid: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

/** Requires a valid Bearer access token whose session is still active. */
export function authenticate(sessions: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) {
      next(AppError.unauthorized());
      return;
    }
    const claims = await sessions.verifyAccess(token);
    if (!claims) {
      next(AppError.unauthorized('Invalid or expired token'));
      return;
    }
    req.user = { id: claims.sub, role: claims.role, mfa: claims.mfa, sid: claims.sid };
    next();
  };
}

/** Like authenticate, but lets anonymous requests through (req.user stays undefined). */
export function optionalAuthenticate(sessions: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (token) {
      const claims = await sessions.verifyAccess(token);
      if (claims) {
        req.user = { id: claims.sub, role: claims.role, mfa: claims.mfa, sid: claims.sid };
      }
    }
    next();
  };
}

/**
 * RBAC guard. Use after `authenticate`. Admin access additionally requires a completed
 * MFA login, so an admin who has not enrolled TOTP can only reach the enrollment endpoints.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(AppError.unauthorized());
      return;
    }
    if (!roles.includes(user.role)) {
      next(AppError.forbidden());
      return;
    }
    if (user.role === 'admin' && !user.mfa) {
      next(new AppError(403, 'MFA_REQUIRED', 'Complete multi-factor authentication first'));
      return;
    }
    next();
  };
}

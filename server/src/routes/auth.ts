import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/common.js';
import { authenticate } from '../middleware/auth.js';
import { User } from '../models/user.js';
import type { AuthService } from '../services/auth.js';
import type { RegistrationService } from '../services/registration.js';
import type { SessionService } from '../services/sessions.js';
import { AppError } from '../utils/errors.js';

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const totpSchema = z.string().regex(/^\d{6}$/, 'must be 6 digits');

const loginBody = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
  totpCode: totpSchema.optional(),
});
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const mfaVerifyBody = z.object({ code: totpSchema });

const registerBody = z
  .object({
    nationalId: z.string().trim().min(4).max(40),
    code: z.string().trim().min(10).max(40),
    email: emailSchema,
    password: z.string().min(10, 'must be at least 10 characters').max(200),
  })
  .refine((v) => v.password.toLowerCase() !== v.email, {
    message: 'password must not be your email',
    path: ['password'],
  });

export function createAuthRouter(
  auth: AuthService,
  sessions: SessionService,
  authLimiter: RequestHandler,
  registration: RegistrationService,
  registerLimiter: RequestHandler,
): Router {
  const router = Router();
  const requireLogin = authenticate(sessions);

  router.post('/register', registerLimiter, validate(registerBody), async (req, res) => {
    res.status(201).json(await registration.register(req.body, { ip: req.ip }));
  });

  router.post('/login', authLimiter, validate(loginBody), async (req, res) => {
    res.json(await auth.login(req.body, { ip: req.ip }));
  });

  router.post('/refresh', authLimiter, validate(refreshBody), async (req, res) => {
    res.json(await auth.refresh(req.body.refreshToken, { ip: req.ip }));
  });

  router.post('/logout', validate(refreshBody), async (req, res) => {
    await auth.logout(req.body.refreshToken, { ip: req.ip });
    res.status(204).end();
  });

  router.get('/me', requireLogin, async (req, res) => {
    const user = await User.findById(req.user!.id).lean();
    if (!user) throw AppError.unauthorized();
    res.json({
      id: user._id.toString(),
      email: user.email,
      role: user.role,
      mfaEnabled: user.totpEnabled,
      mfaEnrollmentRequired: user.role === 'admin' && !req.user!.mfa,
    });
  });

  router.post('/mfa/setup', authLimiter, requireLogin, async (req, res) => {
    res.json(await auth.beginMfaSetup(req.user!.id, { ip: req.ip }));
  });

  router.post('/mfa/verify', authLimiter, requireLogin, validate(mfaVerifyBody), async (req, res) => {
    res.json(
      await auth.completeMfaSetup(req.user!.id, req.user!.sid, req.body.code, { ip: req.ip }),
    );
  });

  return router;
}

import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env.js';
import type { RedisHandle } from './infra/redis.js';
import { authenticate, requireRole } from './middleware/auth.js';
import { errorHandler, notFoundHandler, requestId } from './middleware/common.js';
import { DEFAULT_LIMITS, createLimiter, type Limits } from './middleware/rateLimit.js';
import type { ImageStorage } from './infra/storage.js';
import { createAdminEventsRouter } from './routes/adminEvents.js';
import { createAdminVotersRouter } from './routes/adminVoters.js';
import { VoterService } from './services/voters.js';
import { RegistrationService } from './services/registration.js';
import { createVoterRouter } from './routes/voter.js';
import { createImagesRouter, createPublicEventsRouter } from './routes/publicEvents.js';
import { EventService } from './services/events.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter, type HealthCheck } from './routes/health.js';
import { AuthService } from './services/auth.js';
import { SessionService } from './services/sessions.js';
import { ResultsHub } from './realtime/hub.js';
import { ResultsService, TallyService } from './services/results.js';
import { VotingService } from './services/voting.js';
import { Scheduler } from './services/scheduler.js';
import { createAdminDashboardRouter } from './routes/adminDashboard.js';
import { createAdminExportRouter } from './routes/adminExport.js';
import { HistoryService } from './services/history.js';

export interface AppDeps {
  env: Env;
  redis: RedisHandle;
  storage: ImageStorage;
  healthChecks: HealthCheck[];
  /** Override rate limits (tests use this). */
  limits?: Partial<Limits>;
  /** Live results broadcaster. Attach it to socket.io with createRealtime(). */
  hub?: ResultsHub;
}

export function createApp(deps: AppDeps): Express {
  const { env, redis } = deps;
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };

  const sessions = new SessionService(redis.client, env);
  const authService = new AuthService(env, redis.client, sessions);
  const registrationService = new RegistrationService(env.CODE_PEPPER, authService);
  const hub = deps.hub ?? new ResultsHub();
  const tally = new TallyService(redis.client);
  const resultsService = new ResultsService(tally);
  hub.setProvider((eventId) => resultsService.snapshot(eventId));
  const notify = (eventId: string) => hub.notify(eventId);
  const eventService = new EventService(deps.storage, notify);
  const voterService = new VoterService(env.CODE_PEPPER);
  const votingService = new VotingService(tally, notify);
  const scheduler = new Scheduler(eventService, tally, notify);
  const historyService = new HistoryService(resultsService);

  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(requestId);
  app.use(helmet());
  app.use(cors({ origin: [env.CLIENT_ORIGIN], credentials: true }));
  app.use(express.json({ limit: '100kb' }));

  app.use('/health', createHealthRouter(deps.healthChecks));

  const api = express.Router();
  api.use(createLimiter('general', limits.general, redis));
  api.use(
    '/auth',
    createAuthRouter(
      authService,
      sessions,
      createLimiter('auth', limits.auth, redis),
      registrationService,
      createLimiter('register', limits.register, redis),
    ),
  );
  api.use(
    '/voter',
    authenticate(sessions),
    requireRole('voter'),
    createVoterRouter(votingService, createLimiter('vote', limits.vote, redis)),
  );

  const admin = express.Router();
  admin.use(authenticate(sessions), requireRole('admin'));
  admin.get('/ping', (_req, res) => {
    res.json({ ok: true });
  });
  admin.use(createAdminDashboardRouter());
  admin.use('/events', createAdminExportRouter(resultsService));
  admin.use('/events', createAdminEventsRouter(eventService, resultsService));
  admin.use('/events/:id', createAdminVotersRouter(voterService));
  api.use('/admin', admin);
  api.use('/events', createPublicEventsRouter(eventService, resultsService, historyService));
  api.use('/images', createImagesRouter(deps.storage));

  app.use('/api', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  app.locals.scheduler = scheduler;
  return app;
}

/** Background jobs for this app instance. index.ts starts them; tests call tick() directly. */
export function getScheduler(app: Express): Scheduler {
  return app.locals.scheduler as Scheduler;
}

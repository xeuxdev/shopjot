import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { eq } from 'drizzle-orm';
import {
  z,
  ZodError,
  MoneyRangeError,
  accountResponseSchema,
  credentialsSchema,
  registrationSchema,
  syncOperationSchema,
  cursorSchema,
} from './domain/index';
import { makeDatabase, type Database } from './db/client';
import { stores, users } from './db/schema';
import { authenticate, createSession, endSession, hashPassword, verifyPassword } from './auth';
import { ApiError } from './errors';
import { manifest, pullChanges, pushOperation } from './sync';

interface Options {
  database?: Database;
  logger?: boolean;
  webOrigin?: string;
  secureCookies?: boolean;
}
export function createApp(options: Options = {}) {
  const owned = options.database ? null : makeDatabase();
  const db = options.database ?? owned!.db;
  const secure = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const origin = options.webOrigin ?? process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173';
  if (secure && !origin.startsWith('https://'))
    throw new Error('Production WEB_ORIGIN must be your HTTPS app URL.');
  const app = Fastify({
    bodyLimit: 1024 * 1024,
    logger:
      options.logger === false
        ? false
        : {
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers.set-cookie',
              'password',
            ],
          },
  });
  app.register(cookie);
  app.register(cors, {
    origin,
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  });
  app.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  app.addHook('onRequest', async (request) => {
    if (
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      request.headers.origin !== origin
    )
      throw new ApiError(
        403,
        'ORIGIN_REJECTED',
        'This request did not come from the configured app address.',
      );
  });
  if (owned)
    app.addHook('onClose', async () => {
      await owned.pool.end();
    });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof MoneyRangeError)
      return reply.code(422).send({ code: 'INVALID_AMOUNT', message: error.message });
    if (error instanceof ZodError)
      return reply
        .code(422)
        .send({ code: 'INVALID_INPUT', message: error.issues.map((i) => i.message).join(' ') });
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const failure = error as { code?: string; cause?: { code?: string }; statusCode?: number };
    const code = failure.cause?.code ?? failure.code;
    if (code === '23505')
      return reply.code(409).send({
        code: 'RECORD_CONFLICT',
        message: 'This account or record already exists. Sign in or review the conflicting record.',
      });
    if (code === '23503' || code === '23514')
      return reply.code(422).send({
        code: 'INVALID_OPERATION',
        message: 'This record violates a ledger constraint. Keep the local copy and review it.',
      });
    if (failure.statusCode && failure.statusCode < 500)
      return reply.code(failure.statusCode).send({
        code: failure.statusCode === 429 ? 'RATE_LIMITED' : 'REQUEST_REJECTED',
        message:
          failure.statusCode === 429
            ? 'Please wait briefly before trying again.'
            : 'The request could not be accepted.',
      });
    request.log.error(
      { errorCode: code ?? 'INTERNAL_ERROR', requestId: request.id },
      'API operation failed',
    );
    return reply.code(503).send({
      code: 'SERVER_UNAVAILABLE',
      message: 'The backup server is temporarily unavailable. Your local records have been kept.',
    });
  });
  const health = async () => ({
    status: 'ok',
    service: 'shopjot-api',
    cloudBackupAvailable: true,
  });
  app.get('/health', health);
  app.get('/api/health', health);
  app.get('/api/ready', async () => {
    await db.select({ id: stores.id }).from(stores).limit(1);
    return { status: 'ready' };
  });
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const input = registrationSchema.parse(request.body);
      const passwordHash = await hashPassword(input.password),
        userId = crypto.randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(users).values({ id: userId, email: input.email, passwordHash });
        await tx.insert(stores).values({
          id: input.storeId,
          ownerUserId: userId,
          name: input.storeName,
          primaryDeviceId: input.deviceId,
        });
      });
      await createSession(db, reply, userId, input.deviceId, secure);
      return accountResponseSchema.parse({
        userId,
        email: input.email,
        storeId: input.storeId,
        storeName: input.storeName,
        deviceId: input.deviceId,
        writer: true,
      });
    },
  );
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const input = credentialsSchema.parse(request.body);
      const [user] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
      const valid = user
        ? await verifyPassword(input.password, user.passwordHash)
        : (await hashPassword(input.password), false);
      if (!user || !valid)
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
      const [store] = await db
        .select()
        .from(stores)
        .where(eq(stores.ownerUserId, user.id))
        .limit(1);
      if (input.expectedStoreId && input.expectedStoreId !== store.id)
        throw new ApiError(
          409,
          'LOCAL_LEDGER_MISMATCH',
          'This phone contains another store’s records. Use its existing account or a separate browser profile; no records were removed.',
        );
      await endSession(db, request, reply, secure);
      await createSession(db, reply, user.id, input.deviceId, secure);
      return accountResponseSchema.parse({
        userId: user.id,
        email: user.email,
        storeId: store.id,
        storeName: store.name,
        deviceId: input.deviceId,
        writer: true,
      });
    },
  );
  app.get('/api/auth/me', async (request) =>
    accountResponseSchema.parse(await authenticate(db, request)),
  );
  app.post('/api/auth/logout', async (request, reply) => {
    await endSession(db, request, reply, secure);
    return { ok: true };
  });
  app.post('/api/devices/claim', async (request) => {
    const account = await authenticate(db, request);
    const body = z
      .object({ deviceId: z.uuid(), confirmPreviousDeviceBackedUp: z.literal(true) })
      .parse(request.body);
    if (body.deviceId !== account.deviceId)
      throw new ApiError(403, 'DEVICE_MISMATCH', 'Sign in on this device before switching.');
    // Older installed clients may still call this endpoint. Signing in already
    // enables writing, and this request must never disable another phone.
    return accountResponseSchema.parse({ ...account, writer: true });
  });
  app.post('/api/sync/push', async (request) =>
    pushOperation(db, await authenticate(db, request), syncOperationSchema.parse(request.body)),
  );
  app.get('/api/sync/pull', async (request) => {
    const account = await authenticate(db, request);
    const { cursor } = z.object({ cursor: cursorSchema.default('0') }).parse(request.query);
    return pullChanges(db, account.storeId, cursor);
  });
  app.get('/api/sync/manifest', async (request) =>
    manifest(db, (await authenticate(db, request)).storeId),
  );
  return app;
}

import { randomBytes, scrypt as derive, timingSafeEqual, createHash } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db/client';
import { sessions, stores, users } from './db/schema';
import { ApiError } from './errors';

const COOKIE = 'doris_session';
const lifetimeSeconds = 30 * 24 * 60 * 60;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function key(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    derive(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await key(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [version, salt, encoded] = stored.split('$');
  if (version !== 'scrypt-v1' || !salt || !encoded) return false;
  const expected = Buffer.from(encoded, 'hex'),
    actual = await key(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function createSession(
  db: Database,
  reply: FastifyReply,
  userId: string,
  deviceId: string,
  secure: boolean,
) {
  const token = randomBytes(32).toString('hex');
  await db.insert(sessions).values({
    tokenHash: hash(token),
    userId,
    deviceId,
    expiresAt: new Date(Date.now() + lifetimeSeconds * 1000),
  });
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/api',
    maxAge: lifetimeSeconds,
  });
}
export async function authenticate(db: Database, request: FastifyRequest) {
  const token = request.cookies[COOKIE];
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new ApiError(
      401,
      'SIGN_IN_REQUIRED',
      'Sign in again to continue backing up. Your local records are safe.',
    );
  const [account] = await db
    .select({
      userId: users.id,
      email: users.email,
      storeId: stores.id,
      storeName: stores.name,
      deviceId: sessions.deviceId,
      primaryDeviceId: stores.primaryDeviceId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(stores, eq(stores.ownerUserId, users.id))
    .where(and(eq(sessions.tokenHash, hash(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!account)
    throw new ApiError(
      401,
      'SIGN_IN_REQUIRED',
      'Sign in again to continue backing up. Your local records are safe.',
    );
  return { ...account, writer: account.primaryDeviceId === account.deviceId };
}
export type AuthAccount = Awaited<ReturnType<typeof authenticate>>;
export async function endSession(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
  secure: boolean,
) {
  if (request.cookies[COOKIE])
    await db.delete(sessions).where(eq(sessions.tokenHash, hash(request.cookies[COOKIE]!)));
  reply.clearCookie(COOKIE, { path: '/api', httpOnly: true, sameSite: 'strict', secure });
}

import { describe, it, expect } from 'vitest';
import { createApp } from './app';
describe('API access boundary', () => {
  it('offers sync but rejects unauthenticated ledger access and cross-origin writes', async () => {
    const app = createApp({ logger: false });
    try {
      const health = await app.inject({ url: '/health' });
      expect(health.statusCode).toBe(200);
      expect(health.json().cloudBackupAvailable).toBe(true);
      expect((await app.inject({ url: '/sales' })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/sync/pull?cursor=0' })).statusCode).toBe(401);
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/api/auth/login',
        headers: {
          origin: 'http://127.0.0.1:5173',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
      expect(preflight.headers['access-control-allow-credentials']).toBe('true');
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/auth/register',
            headers: { origin: 'https://untrusted.example' },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});

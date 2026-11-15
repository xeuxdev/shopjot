import { createApp } from './app';
const app = createApp();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void app.close();
  });
try {
  await app.listen({
    port: Number(process.env.API_PORT ?? 3001),
    host: process.env.API_HOST ?? '127.0.0.1',
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

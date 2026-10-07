import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = async () => { await app.close(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
}

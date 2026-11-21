import { app } from './app.js';
import { envInteger } from './env.js';
import { stopYtDlp } from './providers/ytdlp.js';

const port = envInteger('PORT', 4000, 1, 65_535);
const host = process.env.HOST || '0.0.0.0';

let closing = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => {
    app.log.warn('shutdown deadline reached');
    stopYtDlp();
    app.server.closeAllConnections();
  }, 25_000).unref();
  try {
    await app.close();
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exitCode = 1;
  } finally {
    stopYtDlp();
    clearTimeout(deadline);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const address = await app.listen({ port, host });
  app.log.info({ address }, 'Nuclear backend listening');
} catch (err) {
  app.log.error({ err }, 'startup failed');
  process.exitCode = 1;
  await shutdown('SIGTERM');
}

import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getConfig } from './config.js';
import { createLogger } from './logger.js';
import { MessageStore } from './store.js';
import { NexusClient } from './providers/nexus.js';
import { OrbitClient } from './providers/orbit.js';
import { MessagingGateway } from './gateway.js';
import { createHttpHandler } from './router.js';
import { OrbitPoller } from './poller.js';

const config = getConfig();
mkdirSync(dirname(config.databasePath), { recursive: true });
const logger = createLogger();
const store = new MessageStore(config.databasePath);
const nexus = new NexusClient({ ...config.nexus, logger });
const orbit = new OrbitClient(config.orbit);
const gateway = new MessagingGateway({ store, nexus, orbit, logger });
const poller = new OrbitPoller(gateway, { intervalMs: Number(process.env.POLL_INTERVAL_MS || 0), logger });
const server = createServer(createHttpHandler({ gateway, nexusWebhookSecret: config.nexus.webhookSecret, logger }));

server.listen(config.port, () => {
  logger.info('server_started', { port: config.port, database: config.databasePath });
  poller.start();
});

function shutdown() {
  poller.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

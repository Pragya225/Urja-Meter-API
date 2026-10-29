import 'dotenv/config';
import { loadConfig } from './config.js';
import { PortalClient } from './portal/client.js';
import { TtlCache } from './cache.js';
import { createBulkLoader } from './portal/bulk.js';
import { createDataset } from './services/dataset.js';
import { createMeterService } from './services/meters.js';
import { buildApp } from './app.js';

const config = loadConfig();
const client = new PortalClient({
  baseUrl: config.portalUrl,
  email: config.email,
  password: config.password,
  timeoutMs: config.timeoutMs,
  maxConcurrent: config.maxConcurrent,
});
const dataset = createDataset({ loader: createBulkLoader(client), ttlMs: config.ttl.datasetMs });
const meters = createMeterService({ client, cache: new TtlCache(), config, dataset });
const app = await buildApp({ meters, logger: true });

await app.listen({ port: config.port, host: '0.0.0.0' });
dataset.get().catch((err) => app.log.warn({ err }, 'initial bulk load failed; will retry on first request')); // warm the snapshot

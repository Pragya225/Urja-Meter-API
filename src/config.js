/**
 * Central configuration. Everything comes from environment variables so that
 * no credential ever lives in the repository.
 */
export function loadConfig(env = process.env) {
  const required = ['PORTAL_EMAIL', 'PORTAL_PASSWORD'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example`);
  }
  return {
    portalUrl: (env.PORTAL_URL ?? 'https://urja-ops.flockenergy.tech').replace(/\/+$/, ''),
    email: env.PORTAL_EMAIL,
    password: env.PORTAL_PASSWORD,
    port: Number(env.PORT ?? 3000),
    utcOffset: env.PORTAL_UTC_OFFSET ?? '+05:30',
    timeoutMs: Number(env.PORTAL_TIMEOUT_MS ?? 10_000),
    maxConcurrent: Number(env.PORTAL_MAX_CONCURRENT ?? 4),
    // How long we trust cached portal data before asking again.
    ttl: {
      meterMs: Number(env.TTL_METER_MS ?? 60 * 60 * 1000), // nameplate/hierarchy: rarely changes
      geoMs: Number(env.TTL_GEO_MS ?? 24 * 60 * 60 * 1000), // fixed installation location
      energyMs: Number(env.TTL_ENERGY_MS ?? 5 * 60 * 1000), // readings: changes the most
      datasetMs: Number(env.TTL_DATASET_MS ?? 15 * 60 * 1000), // bulk snapshot; refreshed in the background once older
      searchMs: Number(env.TTL_SEARCH_MS ?? 60 * 1000),
    },
  };
}

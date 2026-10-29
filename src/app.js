import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { PortalError, ValidationError } from './errors.js';
import { meterRoutes } from './routes/meters.js';

const STATUS_BY_KIND = { not_found: 404, auth: 502, timeout: 504, unavailable: 502, bad_response: 502 };

/** Builds the HTTP app. The meter service is injected so tests (and the OpenAPI exporter) need no portal. */
export async function buildApp({ meters, logger = false }) {
  // "example" is an OpenAPI keyword, not JSON Schema; tell the validator to accept it.
  const app = Fastify({ logger, ajv: { customOptions: { keywords: ['example'] } } });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Urja Meter Ops API',
        version: '1.0.0',
        description: 'A clean, typed REST API in front of the legacy Urja Meter Ops portal. See PROTOCOL.md for how the portal works.',
      },
      tags: [
        { name: 'meters', description: 'Meter nameplate, location and consumption' },
        { name: 'network', description: 'Transformers, hierarchy tree and data-quality report' },
        { name: 'system', description: 'Service health' },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((err, req, reply) => {
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (err instanceof ValidationError) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (err instanceof PortalError) {
      const status = STATUS_BY_KIND[err.kind] ?? 502;
      const code = err.kind === 'not_found' ? 'not_found' : 'upstream_error';
      if (status >= 500) req.log.error({ err }, 'portal failure');
      return reply.code(status).send({ error: { code, message: err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Unexpected error' } });
  });

  app.get('/health', {
    schema: {
      tags: ['system'],
      summary: 'Liveness plus freshness of the local snapshot',
      response: { 200: { type: 'object', properties: { status: { type: 'string' }, snapshot: { type: 'object', additionalProperties: true } } } },
    },
  }, async () => ({ status: 'ok', snapshot: meters.status?.() ?? null }));
  await app.register(meterRoutes, { meters });
  return app;
}

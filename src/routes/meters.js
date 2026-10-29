import { consumption, dataQuality, errorResponse, hierarchyTree, meterDetail, meterIdParam, meterList, meterListQuery, transformerDetail, transformerList } from '../schemas.js';

const err = { description: 'Error', ...errorResponse };
const errors = { 400: err, 404: err, 502: err, 504: err };

export async function meterRoutes(app, { meters }) {
  app.get('/meters', {
    schema: {
      tags: ['meters'],
      summary: 'Search and filter meters',
      description:
        'Served from a local snapshot of the portal\'s bulk export, so filters the portal cannot do are possible: ' +
        'status, make, phase, transformer, feeder, zone, and proximity (`lat`+`lng`+`radiusKm`, nearest first). ' +
        'If the snapshot cannot be loaded, plain `q`/`page` requests fall back to the portal\'s own search.',
      querystring: meterListQuery,
      response: { 200: meterList, ...errors },
    },
  }, async (req) => meters.listMeters(req.query));

  app.get('/meters/:meterId', {
    schema: {
      tags: ['meters'],
      summary: 'Get one meter',
      description: 'Nameplate, GPS location and network hierarchy (with missing codes repaired and flagged in `quality`).',
      params: meterIdParam,
      response: { 200: meterDetail, ...errors },
    },
  }, async (req) => meters.getMeter(req.params.meterId));

  app.get('/meters/:meterId/consumption', {
    schema: {
      tags: ['meters'],
      summary: 'Meter consumption readings (resolution varies per meter)',
      description:
        'The portal exposes cumulative kWh/kVAh registers at a resolution that differs per meter (e.g. 30-minute or daily; see summary.intervalMinutes). This endpoint also derives per-interval consumption, ' +
        'a summary and the power factor. Timestamps are ISO 8601; the portal gives local time without a zone, so we assume IST (+05:30).',
      params: meterIdParam,
      querystring: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date-time', description: 'Inclusive lower bound' },
          to: { type: 'string', format: 'date-time', description: 'Inclusive upper bound' },
        },
      },
      response: { 200: consumption, ...errors },
    },
  }, async (req) => meters.getConsumption(req.params.meterId, req.query));

  app.get('/transformers', {
    schema: {
      tags: ['network'],
      summary: 'List distribution transformers',
      querystring: { type: 'object', properties: { zone: { type: 'string', description: 'Zone code, e.g. Z-02' }, feeder: { type: 'string', description: 'Feeder code, e.g. F-003' } } },
      response: { 200: transformerList, ...errors },
    },
  }, async (req) => meters.listTransformers(req.query));

  app.get('/transformers/:code', {
    schema: {
      tags: ['network'],
      summary: 'One transformer with its meters',
      params: { type: 'object', required: ['code'], properties: { code: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$', example: 'DT-003' } } },
      response: { 200: transformerDetail, ...errors },
    },
  }, async (req) => meters.getTransformer(req.params.code));

  app.get('/hierarchy', {
    schema: {
      tags: ['network'],
      summary: 'Full network tree with meter counts',
      description: 'Reconstructed from every meter\'s hierarchy. Nodes are keyed by their full path because the portal reuses codes under different parents.',
      response: { 200: hierarchyTree, ...errors },
    },
  }, async () => meters.getHierarchy());

  app.get('/data-quality', {
    schema: {
      tags: ['network'],
      summary: 'Inconsistencies found in the portal data, and what we did about each',
      response: { 200: dataQuality, ...errors },
    },
  }, async () => meters.getDataQuality());
}

// Generates openapi.json from the route schemas. No portal or credentials needed.
import { writeFileSync } from 'node:fs';
import { buildApp } from '../src/app.js';

const app = await buildApp({ meters: {} });
await app.ready();
writeFileSync(new URL('../openapi.json', import.meta.url), JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
console.log('openapi.json written');

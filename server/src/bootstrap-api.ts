import { startTelemetry } from './telemetry.js';

// Dynamic import is intentional: OTel must patch Fastify/MySQL/Redis before
// those libraries are loaded by the API entry point.
await startTelemetry('api');
const { startApi } = await import('./index.js');
await startApi();

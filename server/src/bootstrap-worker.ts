import { startTelemetry } from './telemetry.js';

// Dynamic import is intentional: load OTel before Redis/MySQL are imported.
await startTelemetry('worker');
const { startWorker } = await import('./worker.js');
await startWorker();

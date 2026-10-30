/**
 * Opt-in OpenTelemetry bootstrap shared by the HTTP API and the queue worker.
 *
 * It deliberately does nothing unless both OTEL_ENABLED and an OTLP traces
 * endpoint are configured. That keeps a developer's normal `npm run dev`
 * startup quiet and avoids a hidden dependency on a local Collector.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { emitProcessLog } from './lib/process-log.js';

let sdk: NodeSDK | undefined;
let stopping: Promise<void> | undefined;

function enabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.OTEL_ENABLED ?? '');
}

/** Starts tracing before the application modules are imported and patched. */
export async function startTelemetry(role: 'api' | 'worker'): Promise<void> {
  if (!enabled()) return;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    emitProcessLog('warn', '[otel] OTEL_ENABLED=true，但未设置 OTEL_EXPORTER_OTLP_TRACES_ENDPOINT；已跳过追踪导出', {
      msg: 'otel skipped',
    });
    return;
  }

  sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME || `benchu-canvas-${role}`,
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [getNodeAutoInstrumentations()],
  });
  await sdk.start();
  const service = process.env.OTEL_SERVICE_NAME || `benchu-canvas-${role}`;
  emitProcessLog('info', `[otel] tracing enabled: service=${service}`, { msg: 'otel enabled', service });
}

/** Flushes queued spans. Safe to call from multiple shutdown paths. */
export function stopTelemetry(): Promise<void> {
  if (!sdk) return Promise.resolve();
  stopping ??= sdk.shutdown().catch((err) => {
    console.error('[otel] shutdown failed:', err);
  });
  return stopping;
}

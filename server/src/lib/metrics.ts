/**
 * Minimal Prometheus exposition without a client library.
 *
 * Deliberately tiny: counters, gauges and histograms are all this service
 * needs, and avoiding a dependency keeps cold start and image size down.
 * Labels are rendered as separate series, so cardinality is the caller's
 * responsibility — never put a user id or task id in a label.
 */

type Counter = { name: string; help: string; values: Map<string, number> };
type Gauge = { name: string; help: string; fn: () => number };
type Histogram = {
  name: string;
  help: string;
  buckets: number[];
  /** label key → per-bucket counts + sum + count */
  series: Map<string, { counts: number[]; sum: number; count: number }>;
};

const counters = new Map<string, Counter>();
const gauges = new Map<string, Gauge>();
const histograms = new Map<string, Histogram>();

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function labelKey(labels?: Record<string, string>): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`).join(',');
}

export function incCounter(name: string, help = name, by = 1, labels?: Record<string, string>) {
  let c = counters.get(name);
  if (!c) {
    c = { name, help, values: new Map() };
    counters.set(name, c);
  }
  const key = labelKey(labels);
  c.values.set(key, (c.values.get(key) ?? 0) + by);
}

export function registerGauge(name: string, help: string, fn: () => number) {
  gauges.set(name, { name, help, fn });
}

export function observeHistogram(
  name: string,
  help: string,
  value: number,
  labels?: Record<string, string>,
  buckets: number[] = DEFAULT_BUCKETS,
) {
  let h = histograms.get(name);
  if (!h) {
    h = { name, help, buckets, series: new Map() };
    histograms.set(name, h);
  }
  const key = labelKey(labels);
  let s = h.series.get(key);
  if (!s) {
    s = { counts: buckets.map(() => 0), sum: 0, count: 0 };
    h.series.set(key, s);
  }
  const v = Number.isFinite(value) ? value : 0;
  s.sum += v;
  s.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (v <= h.buckets[i]) s.counts[i] += 1;
  }
}

export function renderPrometheus(extra?: Record<string, number>): string {
  const lines: string[] = [];

  for (const c of counters.values()) {
    lines.push(`# HELP ${c.name} ${c.help}`, `# TYPE ${c.name} counter`);
    for (const [key, value] of c.values) {
      lines.push(key ? `${c.name}{${key}} ${value}` : `${c.name} ${value}`);
    }
  }

  for (const g of gauges.values()) {
    lines.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, `${g.name} ${g.fn()}`);
  }

  for (const h of histograms.values()) {
    lines.push(`# HELP ${h.name} ${h.help}`, `# TYPE ${h.name} histogram`);
    for (const [key, s] of h.series) {
      const merge = (bucketKey: string) =>
        bucketKey ? (key ? `${key},${bucketKey}` : bucketKey) : key;
      for (let i = 0; i < h.buckets.length; i++) {
        lines.push(`${h.name}_bucket{${merge(`le="${h.buckets[i]}"`)}} ${s.counts[i]}`);
      }
      lines.push(`${h.name}_bucket{${merge('le="+Inf"')}} ${s.count}`);
      lines.push(key ? `${h.name}_sum{${key}} ${s.sum}` : `${h.name}_sum ${s.sum}`);
      lines.push(key ? `${h.name}_count{${key}} ${s.count}` : `${h.name}_count ${s.count}`);
    }
  }

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      lines.push(`# HELP ${k} ${k}`, `# TYPE ${k} gauge`, `${k} ${v}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Test hook — keeps assertions independent between runs. */
export function resetMetrics() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

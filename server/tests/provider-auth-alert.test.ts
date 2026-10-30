import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('provider credential alert', () => {
  it('pages when any PROVIDER_AUTH sample appears', () => {
    const rules = readFileSync(join(here, '../../deploy/prometheus/alerts.yml'), 'utf8');
    expect(rules).toContain('alert: ProviderCredentialRejected');
    expect(rules).toContain('increase(benchu_provider_auth_total[5m]) > 0');
    expect(rules).toContain('for: 1m');
    expect(rules).toContain('runbook:');
  });

  it('pages when retries are exhausted', () => {
    const rules = readFileSync(join(here, '../../deploy/prometheus/alerts.yml'), 'utf8');
    expect(rules).toContain('alert: TaskRetriesExhausted');
    expect(rules).toContain('increase(benchu_tasks_dead_letter_total[10m]) > 0');
    expect(rules).toContain('for: 5m');
    const dashboard = readFileSync(join(here, '../../deploy/grafana/dashboards/overview.json'), 'utf8');
    expect(dashboard).toContain('sum(increase(benchu_tasks_dead_letter_total[1h]))');
    expect(dashboard).toContain('sum(increase(benchu_provider_auth_total[1h]))');
    expect(() => JSON.parse(dashboard)).not.toThrow();
  });
});
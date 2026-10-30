import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canaryPath = path.join(root, 'deploy', 'k8s', 'ingress-canary.yaml');
const apiPath = path.join(root, 'deploy', 'k8s', 'api.yaml');

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function ingressSection(yaml) {
  const section = yaml.split(/^---\s*$/m).find((doc) => /^kind:\s+Ingress\s*$/m.test(doc));
  assert.ok(section, 'expected an Ingress document');
  return section;
}

test('canary manifest opts in with zero weight and the canary service', () => {
  const text = readText(canaryPath);
  assert.ok(text.includes('canary: "true"'));
  assert.ok(text.includes('canary-weight: "0"'));
  assert.ok(text.includes('X-Canary'));
  assert.ok(text.includes('benchu_canary'));
  assert.ok(text.includes('api-canary'));
});

test('both Ingresses allow only TLS 1.2 and 1.3', () => {
  for (const filePath of [apiPath, canaryPath]) {
    const section = ingressSection(readText(filePath));
    assert.match(section, /ssl-protocols:\s*'TLSv1\.2 TLSv1\.3'/);
  }
});

test('stable Ingress does not carry a canary weight', () => {
  const section = ingressSection(readText(apiPath));
  assert.equal(section.includes('canary-weight'), false);
});

test('canary manifest does not embed real secrets', () => {
  const text = readText(canaryPath);
  for (const marker of ['AKIA', 'sk_live', 'BEGIN PRIVATE KEY']) {
    assert.equal(text.includes(marker), false, marker);
  }
});

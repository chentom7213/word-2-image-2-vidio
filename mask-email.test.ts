import assert from 'node:assert/strict';
import test from 'node:test';
import { maskEmail } from './src/lib/mask-email.ts';

test('keeps the domain and only the ends of a normal local part', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***e@example.com');
});

test('a two-character local part does not reveal the second character', () => {
  assert.equal(maskEmail('ab@example.com'), 'a***@example.com');
});

test('masking an already masked address stays the same', () => {
  assert.equal(maskEmail(maskEmail('alice@example.com')), 'a***e@example.com');
});

test('a value without a usable address becomes a placeholder', () => {
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskEmail(''), '***');
});

import { describe, expect, it } from 'vitest';
import { apiKeyCreateMessage } from '../src/lib/api-key-create.js';

const RATE_LIMIT = '每分钟上限需为 1 到 10000 的整数';

describe('apiKeyCreateMessage', () => {
  it('空数组 scopes 返回请至少选择一项权限', () => {
    expect(apiKeyCreateMessage('scopes', { scopes: [] })).toBe('请至少选择一项权限');
  });

  it('scopes 为字符串、null、未知枚举或含非法项时返回权限项无效', () => {
    expect(apiKeyCreateMessage('scopes', { scopes: 'generate:image' })).toBe('权限项无效');
    expect(apiKeyCreateMessage('scopes', { scopes: null })).toBe('权限项无效');
    expect(apiKeyCreateMessage('scopes', { scopes: 'not-a-scope' })).toBe('权限项无效');
    expect(apiKeyCreateMessage('scopes', { scopes: ['generate:image', 'nope'] })).toBe('权限项无效');
  });

  it('rateLimit 返回每分钟上限需为 1 到 10000 的整数', () => {
    expect(apiKeyCreateMessage('rateLimit', { rateLimit: 0 })).toBe(RATE_LIMIT);
    expect(apiKeyCreateMessage('rateLimit', { rateLimit: '60' })).toBe(RATE_LIMIT);
  });

  it('expiresAt 返回到期时间无效', () => {
    expect(apiKeyCreateMessage('expiresAt', { expiresAt: 'tomorrow' })).toBe('到期时间无效');
    expect(apiKeyCreateMessage('expiresAt', { expiresAt: 1 })).toBe('到期时间无效');
  });

  it('name 和 undefined 返回 null', () => {
    expect(apiKeyCreateMessage('name', { name: '' })).toBeNull();
    expect(apiKeyCreateMessage(undefined, {})).toBeNull();
  });
});

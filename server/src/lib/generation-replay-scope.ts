import { apiScopeAllows } from '../middleware/auth.js';

const REPLAY_SCOPE_DENIED = 'API Key 缺少所需权限';

/**
 * 幂等重放按库里已有任务的种类验权，不看这次请求体声明的 type。
 * 网页登录没有 scope 列表；* 表示该钥匙可以读、建全部种类。
 */
export function replayTaskScope(scopes: string[] | undefined, taskType: string): string | null {
  if (taskType === 'image' || taskType === 'video') {
    return apiScopeAllows(scopes, [`generate:${taskType}`]) ? null : REPLAY_SCOPE_DENIED;
  }
  if (!scopes || scopes.includes('*')) return null;
  return REPLAY_SCOPE_DENIED;
}

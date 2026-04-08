/**
 * Token 配额检查辅助函数
 * 用于检查 token 的模型组可用性，支持 429 错误时的级联配额管理
 */
import tokenCooldownManager from '../auth/token_cooldown_manager.js';

// 核心模型组及其代表性模型
const CORE_GROUPS = {
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.0-flash-exp',
  banana: 'imagen-3.0-generate-001'
};

/**
 * 检查 token 是否还有其他可用的模型组
 * @param {string} tokenId - Token ID
 * @returns {boolean} 是否有其他可用模型组
 */
export function hasOtherAvailableModelGroups(tokenId) {
  for (const [, modelId] of Object.entries(CORE_GROUPS)) {
    if (tokenCooldownManager.isAvailable(tokenId, modelId)) {
      return true;
    }
  }
  return false;
}

/**
 * 获取 token 当前可用的模型组列表
 * @param {string} tokenId - Token ID
 * @returns {string[]} 可用的模型组键名数组
 */
export function getAvailableModelGroups(tokenId) {
  return Object.entries(CORE_GROUPS)
    .filter(([, modelId]) => tokenCooldownManager.isAvailable(tokenId, modelId))
    .map(([groupKey]) => groupKey);
}
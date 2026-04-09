import { log } from '../utils/logger.js';
import { generateTokenId } from '../utils/idGenerator.js';

/**
 * Token 池管理类
 * 负责 Token 的存储和基本操作，使用 Map 替代数组索引以避免索引失效问题
 */
class TokenPool {
  constructor(store) {
    this.store = store;
    /** @type {Map<string, Object>} key: tokenId, value: token 对象 */
    this.tokens = new Map();
    /** @type {Set<string>} 启用的 tokenId 集合 */
    this.enabledTokens = new Set();
    /** @type {Set<string>} 有额度的 tokenId 集合 */
    this.quotaAvailableTokens = new Set();
    /** @type {boolean} 操作锁，用于事务处理 */
    this._locked = false;
  }

  /**
   * 生成 token 的唯一标识符
   * @param {Object} token - Token 对象
   * @returns {Promise<string>} tokenId
   */
  async generateTokenId(token) {
    const salt = await this.store.getSalt();
    return generateTokenId(token.refresh_token, salt);
  }

  /**
   * 添加 token 到池中
   * @param {Object} token - Token 对象
   * @returns {Promise<string>} 添加的 tokenId
   */
  async add(token) {
    const tokenId = await this.generateTokenId(token);
    this.tokens.set(tokenId, token);

    if (token.enable !== false) {
      this.enabledTokens.add(tokenId);
    }

    if (token.hasQuota !== false) {
      this.quotaAvailableTokens.add(tokenId);
    }

    return tokenId;
  }

  /**
   * 批量添加 tokens
   * @param {Array<Object>} tokenArray - Token 数组
   * @returns {Promise<Array<string>>} 添加的 tokenId 数组
   */
  async addAll(tokenArray) {
    const tokenIds = [];
    for (const token of tokenArray) {
      const tokenId = await this.add(token);
      tokenIds.push(tokenId);
    }
    return tokenIds;
  }

  /**
   * 根据 tokenId 获取 token
   * @param {string} tokenId - Token ID
   * @returns {Object|null} token 对象或 null
   */
  get(tokenId) {
    return this.tokens.get(tokenId) || null;
  }

  /**
   * 根据 refresh_token 查找 tokenId
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<string|null>} tokenId 或 null
   */
  async findTokenId(refreshToken) {
    const salt = await this.store.getSalt();
    const expectedTokenId = generateTokenId(refreshToken, salt);
    return this.tokens.has(expectedTokenId) ? expectedTokenId : null;
  }

  /**
   * 根据 refresh_token 查找 token
   * @param {string} refreshToken - refresh_token
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async findByRefreshToken(refreshToken) {
    const tokenId = await this.findTokenId(refreshToken);
    return tokenId ? this.get(tokenId) : null;
  }

  /**
   * 更新 token
   * @param {string} tokenId - Token ID
   * @param {Object} updates - 更新内容
   * @returns {boolean} 是否成功
   */
  update(tokenId, updates) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    // 更新 token 数据
    Object.assign(token, updates);

    // 更新启用状态
    if (updates.enable !== undefined) {
      if (updates.enable) {
        this.enabledTokens.add(tokenId);
      } else {
        this.enabledTokens.delete(tokenId);
      }
    }

    // 更新额度状态
    if (updates.hasQuota !== undefined) {
      if (updates.hasQuota) {
        this.quotaAvailableTokens.add(tokenId);
      } else {
        this.quotaAvailableTokens.delete(tokenId);
      }
    }

    return true;
  }

  /**
   * 禁用 token
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否成功
   */
  disable(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.enable = false;
    this.enabledTokens.delete(tokenId);
    return true;
  }

  /**
   * 启用 token
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否成功
   */
  enable(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.enable = true;
    this.enabledTokens.add(tokenId);
    return true;
  }

  /**
   * 标记 token 额度耗尽
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否成功
   */
  markQuotaExhausted(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.hasQuota = false;
    this.quotaAvailableTokens.delete(tokenId);
    return true;
  }

  /**
   * 恢复 token 额度
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否成功
   */
  restoreQuota(tokenId) {
    const token = this.tokens.get(tokenId);
    if (!token) return false;

    token.hasQuota = true;
    this.quotaAvailableTokens.add(tokenId);
    return true;
  }

  /**
   * 删除 token
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否成功
   */
  remove(tokenId) {
    const result = this.tokens.delete(tokenId);
    if (result) {
      this.enabledTokens.delete(tokenId);
      this.quotaAvailableTokens.delete(tokenId);
    }
    return result;
  }

  /**
   * 清空池
   */
  clear() {
    this.tokens.clear();
    this.enabledTokens.clear();
    this.quotaAvailableTokens.clear();
  }

  /**
   * 获取所有启用的 tokens
   * @returns {Array<Object>} token 数组
   */
  getEnabled() {
    return Array.from(this.enabledTokens).map(id => this.tokens.get(id));
  }

  /**
   * 获取所有有额度的 tokens
   * @returns {Array<Object>} token 数组
   */
  getWithQuota() {
    return Array.from(this.quotaAvailableTokens).map(id => this.tokens.get(id));
  }

  /**
   * 获取所有启用且有额度的 tokens
   * @returns {Array<Object>} token 数组
   */
  getEnabledWithQuota() {
    const enabledWithQuota = new Set(
      [...this.enabledTokens].filter(id => this.quotaAvailableTokens.has(id))
    );
    return Array.from(enabledWithQuota).map(id => this.tokens.get(id));
  }

  /**
   * 获取所有 tokens
   * @returns {Array<Object>} token 数组
   */
  getAll() {
    return Array.from(this.tokens.values());
  }

  /**
   * 获取所有 tokenIds
   * @returns {Array<string>} tokenId 数组
   */
  getAllIds() {
    return Array.from(this.tokens.keys());
  }

  /**
   * 获取启用的 tokenIds
   * @returns {Array<string>} tokenId 数组
   */
  getEnabledIds() {
    return Array.from(this.enabledTokens);
  }

  /**
   * 获取有额度的 tokenIds
   * @returns {Array<string>} tokenId 数组
   */
  getQuotaAvailableIds() {
    return Array.from(this.quotaAvailableTokens);
  }

  /**
   * 获取启用且有额度的 tokenIds
   * @returns {Array<string>} tokenId 数组
   */
  getEnabledWithQuotaIds() {
    return [...this.enabledTokens].filter(id => this.quotaAvailableTokens.has(id));
  }

  /**
   * 检查 token 是否存在
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否存在
   */
  has(tokenId) {
    return this.tokens.has(tokenId);
  }

  /**
   * 检查 token 是否启用
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否启用
   */
  isEnabled(tokenId) {
    return this.enabledTokens.has(tokenId);
  }

  /**
   * 检查 token 是否有额度
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否有额度
   */
  hasQuota(tokenId) {
    return this.quotaAvailableTokens.has(tokenId);
  }

  /**
   * 获取池大小
   * @returns {number} token 总数
   */
  size() {
    return this.tokens.size;
  }

  /**
   * 获取启用的 token 数量
   * @returns {number} 启用的 token 数量
   */
  enabledSize() {
    return this.enabledTokens.size;
  }

  /**
   * 获取有额度的 token 数量
   * @returns {number} 有额度的 token 数量
   */
  quotaAvailableSize() {
    return this.quotaAvailableTokens.size;
  }

  /**
   * 重置所有 token 的额度状态
   */
  resetAllQuotas() {
    log.warn('重置所有 token 的额度状态');
    for (const token of this.tokens.values()) {
      token.hasQuota = true;
    }
    // 重建额度可用集合
    this.quotaAvailableTokens.clear();
    for (const tokenId of this.tokens.keys()) {
      this.quotaAvailableTokens.add(tokenId);
    }
  }

  /**
   * 执行事务操作（带锁）
   * @param {Function} fn - 要执行的操作函数
   * @returns {Promise<any>} 操作结果
   */
  async transaction(fn) {
    // 简单的自旋锁
    while (this._locked) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this._locked = true;
    try {
      return await fn();
    } finally {
      this._locked = false;
    }
  }

  /**
   * 带事务的禁用操作
   * @param {string} tokenId - Token ID
   * @returns {Promise<boolean>} 是否成功
   */
  async disableWithTransaction(tokenId) {
    return this.transaction(() => {
      return this.disable(tokenId);
    });
  }

  /**
   * 带事务的删除操作
   * @param {string} tokenId - Token ID
   * @returns {Promise<boolean>} 是否成功
   */
  async removeWithTransaction(tokenId) {
    return this.transaction(() => {
      return this.remove(tokenId);
    });
  }
}

export default TokenPool;

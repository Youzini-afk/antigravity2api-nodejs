import axios from 'axios';
import { log } from '../utils/logger.js';
import config from '../config/config.js';
import { buildAxiosRequestConfig } from '../utils/httpClient.js';

/**
 * ProjectId 获取类
 * 负责从 Google API 获取 projectId
 */
class ProjectIdFetcher {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 5;
    this.retryDelay = options.retryDelay || 2000;
    this.timeout = options.timeout || 30000;
  }

  /**
   * 获取 projectId（尝试两种方式）
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string|undefined, sub: string}>} projectId 和 sub
   */
  async fetchProjectId(token) {
    // 步骤1: 尝试 loadCodeAssist
    try {
      const result = await this._tryLoadCodeAssist(token);
      if (result?.projectId) {
        return result;
      }
      log.warn('[fetchProjectId] loadCodeAssist 未返回 projectId，回退到 onboardUser');
    } catch (err) {
      log.warn(`[fetchProjectId] loadCodeAssist 失败: ${err.message}，回退到 onboardUser`);
    }

    // 步骤2: 回退到 onboardUser
    try {
      const result = await this._tryOnboardUser(token);
      if (result?.projectId) {
        return result;
      }
      log.error('[fetchProjectId] loadCodeAssist 和 onboardUser 均未能获取 projectId');
      return { projectId: undefined, sub: 'free-tier' };
    } catch (err) {
      log.error(`[fetchProjectId] onboardUser 失败: ${err.message}`);
      return { projectId: undefined, sub: 'free-tier' };
    }
  }

  /**
   * 尝试通过 loadCodeAssist 获取 projectId
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string, sub: string}|null>} projectId 和 sub 或 null
   * @private
   */
  async _tryLoadCodeAssist(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[loadCodeAssist] 请求: ${requestUrl}`);
    const response = await axios(buildAxiosRequestConfig({
      method: 'POST',
      url: requestUrl,
      headers: {
        'Host': apiHost,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      },
      data: JSON.stringify(requestBody),
      timeout: this.timeout
    }));

    const data = response.data;

    // 检查是否有 currentTier（表示用户已激活）
    let sub = 'free-tier';
    if (data?.currentTier) {
      log.info('[loadCodeAssist] 用户已激活');
      const projectId = data.cloudaicompanionProject;
      if (projectId) {
        log.info(`[loadCodeAssist] 成功获取 projectId: ${projectId}`);
        sub = data.currentTier.id;
        return { projectId, sub };
      }
      log.warn('[loadCodeAssist] 响应中无 projectId');
      return null;
    }

    log.info('[loadCodeAssist] 用户未激活 (无 currentTier)');
    return null;
  }

  /**
   * 尝试通过 onboardUser 获取 projectId（长时间运行操作，需要轮询）
   * @param {Object} token - Token 对象
   * @returns {Promise<{projectId: string, sub: string}|null>} projectId 和 sub 或 null
   * @private
   */
  async _tryOnboardUser(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:onboardUser`;

    // 首先获取用户的 tier 信息
    const tierId = await this._getOnboardTier(token);
    if (!tierId) {
      log.error('[onboardUser] 无法确定用户 tier');
      return null;
    }

    log.info(`[onboardUser] 用户 tier: ${tierId}`);

    const requestBody = {
      tierId: tierId,
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[onboardUser] 请求: ${requestUrl}`);

    // onboardUser 是长时间运行操作，需要轮询
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      log.info(`[onboardUser] 轮询尝试 ${attempt}/${this.maxRetries}`);

      const response = await axios(buildAxiosRequestConfig({
        method: 'POST',
        url: requestUrl,
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        data: JSON.stringify(requestBody),
        timeout: this.timeout
      }));

      const data = response.data;

      // 检查长时间运行操作是否完成
      let sub = 'g1-pro-tier';
      if (data?.done) {
        log.info('[onboardUser] 操作完成');
        const responseData = data.response || {};
        const projectObj = responseData.cloudaicompanionProject;

        let projectId = null;
        if (typeof projectObj === 'object' && projectObj !== null) {
          projectId = projectObj.id;
        } else if (typeof projectObj === 'string') {
          projectId = projectObj;
        }

        if (projectId) {
          log.info(`[onboardUser] 成功获取 projectId: ${projectId}`);
          return { projectId, sub };
        }
        log.warn('[onboardUser] 操作完成但响应中无 projectId');
        return null;
      }

      log.info(`[onboardUser] 操作进行中，等待 ${this.retryDelay}ms...`);
      await this._sleep(this.retryDelay);
    }

    log.error(`[onboardUser] 超时：操作未在 ${this.maxRetries * this.retryDelay / 1000} 秒内完成`);
    return null;
  }

  /**
   * 从 loadCodeAssist 响应中获取用户应该注册的 tier
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} tier_id 或 null
   * @private
   */
  async _getOnboardTier(token) {
    const apiHost = config.api.host;
    const requestUrl = `https://${apiHost}/v1internal:loadCodeAssist`;
    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    log.info(`[_getOnboardTier] 请求: ${requestUrl}`);

    try {
      const response = await axios(buildAxiosRequestConfig({
        method: 'POST',
        url: requestUrl,
        headers: {
          'Host': apiHost,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        data: JSON.stringify(requestBody),
        timeout: this.timeout
      }));

      const data = response.data;

      // 查找默认的 tier
      const allowedTiers = data?.allowedTiers || [];
      for (const tier of allowedTiers) {
        if (tier.isDefault) {
          log.info(`[_getOnboardTier] 找到默认 tier: ${tier.id}`);
          return tier.id;
        }
      }

      // 如果没有默认 tier，使用 LEGACY 作为回退
      log.warn('[_getOnboardTier] 未找到默认 tier，使用 LEGACY');
      return 'LEGACY';
    } catch (err) {
      log.error(`[_getOnboardTier] 获取 tier 失败: ${err.message}`);
      return null;
    }
  }

  /**
   * 睡眠指定时间
   * @param {number} ms - 毫秒数
   * @returns {Promise<void>}
   * @private
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 设置最大重试次数
   * @param {number} retries - 重试次数
   */
  setMaxRetries(retries) {
    if (retries > 0) {
      this.maxRetries = retries;
    }
  }

  /**
   * 设置重试延迟
   * @param {number} delay - 延迟时间（毫秒）
   */
  setRetryDelay(delay) {
    if (delay > 0) {
      this.retryDelay = delay;
    }
  }

  /**
   * 设置超时时间
   * @param {number} timeout - 超时时间（毫秒）
   */
  setTimeout(timeout) {
    if (timeout > 0) {
      this.timeout = timeout;
    }
  }
}

export default ProjectIdFetcher;
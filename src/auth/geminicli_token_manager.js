import axios from 'axios';
import path from 'path';
import { log } from '../utils/logger.js';
import { generateTokenId } from '../utils/idGenerator.js';
import config, { getConfigJson } from '../config/config.js';
import { GEMINICLI_OAUTH_CONFIG } from '../constants/oauth.js';
import { buildAxiosRequestConfig, httpRequest } from '../utils/httpClient.js';
import {
  DEFAULT_REQUEST_COUNT_PER_TOKEN,
  TOKEN_REFRESH_BUFFER
} from '../constants/index.js';
import TokenStore from './token_store.js';
import { TokenError } from '../utils/errors.js';
import { getDataDir } from '../utils/paths.js';
import quotaManager from './quota_manager.js';

// Gemini CLI API 配置
const GEMINICLI_API_CONFIG = {
  HOST: 'cloudcode-pa.googleapis.com',
  USER_AGENT: 'GeminiCLI/0.1.5 (Windows; AMD64)',
  BASE_URL: 'https://cloudcode-pa.googleapis.com'
};

// 轮询策略枚举（复用 token_manager.js 的定义）
const RotationStrategy = {
  ROUND_ROBIN: 'round_robin',           // 均衡负载：每次请求切换
  QUOTA_EXHAUSTED: 'quota_exhausted',   // 额度耗尽才切换
  REQUEST_COUNT: 'request_count'        // 自定义次数后切换
};

const DEFAULT_THRESHOLD_POLICY = Object.freeze({
  enabled: false,
  modelGroupPercent: 20,
  globalPercent: 20,
  applyStrategies: {
    round_robin: true,
    request_count: true,
    quota_exhausted: true
  },
  allBelowThresholdAction: 'strict'
});

const DEFAULT_TOKEN_THRESHOLD_CONTROL = Object.freeze({
  useThreshold: true,
  allowBypassWithSpecialKey: true
});

function clampPercent(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
}

function cloneThresholdPolicy(policy) {
  return {
    enabled: policy.enabled,
    modelGroupPercent: policy.modelGroupPercent,
    globalPercent: policy.globalPercent,
    applyStrategies: { ...policy.applyStrategies },
    allBelowThresholdAction: policy.allBelowThresholdAction
  };
}

function normalizeTokenThresholdControl(input) {
  const result = { ...DEFAULT_TOKEN_THRESHOLD_CONTROL };
  if (!input || typeof input !== 'object') return result;

  if (typeof input.useThreshold === 'boolean') {
    result.useThreshold = input.useThreshold;
  }
  if (typeof input.allowBypassWithSpecialKey === 'boolean') {
    result.allowBypassWithSpecialKey = input.allowBypassWithSpecialKey;
  }

  return result;
}

/**
 * Gemini CLI Token 管理器
 * 基于 TokenManager 简化实现，专门用于 Gemini CLI 反代
 * 主要区别：
 * 1. 使用 geminicli_accounts.json 存储
 * 2. 使用 GEMINICLI_OAUTH_CONFIG 刷新 token
 * 3. 不需要 projectId 和 sessionId
 */
class GeminiCliTokenManager {
  /**
   * @param {string} filePath - Token 数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), 'geminicli_accounts.json')) {
    this.store = new TokenStore(filePath);
    /** @type {Array<Object>} */
    this.tokens = [];
    /** @type {number} */
    this.currentIndex = 0;

    // 轮询策略相关
    /** @type {string} */
    this.rotationStrategy = RotationStrategy.ROUND_ROBIN;
    /** @type {number} */
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;
    /** @type {Map<string, number>} */
    this.tokenRequestCounts = new Map();
    this.thresholdPolicy = cloneThresholdPolicy(DEFAULT_THRESHOLD_POLICY);
    this.quotaRefreshInFlight = new Map();

    /** @type {Promise<void>|null} */
    this._initPromise = null;
  }

  async _initialize() {
    try {
      log.info('[GeminiCLI] 正在初始化token管理器...');
      const tokenArray = await this.store.readAll();

      // Gemini CLI 不需要 sessionId
      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token,
        ...normalizeTokenThresholdControl(token)
      }));

      this.currentIndex = 0;
      this.tokenRequestCounts.clear();

      // 加载轮询策略配置
      this.loadRotationConfig();

      if (this.tokens.length === 0) {
        log.warn('[GeminiCLI] ⚠ 暂无可用账号，请使用以下方式添加：');
        log.warn('[GeminiCLI]   方式1: 访问前端管理页面添加账号');
        log.warn('[GeminiCLI]   方式2: 手动编辑 geminicli_accounts.json');
      } else {
        log.info(`[GeminiCLI] 成功加载 ${this.tokens.length} 个可用token`);
        if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
          log.info(`[GeminiCLI] 轮询策略: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`);
        } else {
          log.info(`[GeminiCLI] 轮询策略: ${this.rotationStrategy}`);
        }

        // 并发刷新所有过期的 token
        await this._refreshExpiredTokensConcurrently();
      }
    } catch (error) {
      log.error('[GeminiCLI] 初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  /**
   * 并发刷新所有过期的 token
   * @private
   */
  async _refreshExpiredTokensConcurrently() {
    const expiredTokens = this.tokens.filter(token => this.isExpired(token));
    if (expiredTokens.length === 0) {
      return;
    }

    const salt = await this.store.getSalt();
    const tokenIds = expiredTokens.map(token => generateTokenId(token.refresh_token, salt));

    log.info(`[GeminiCLI] 正在批量刷新 ${tokenIds.length} 个token: ${tokenIds.join(', ')}`);
    const startTime = Date.now();

    const results = await Promise.allSettled(
      expiredTokens.map(token => this._refreshTokenSafe(token))
    );

    let successCount = 0;
    let failCount = 0;
    const tokensToDisable = [];
    const failedTokenIds = [];

    results.forEach((result, index) => {
      const token = expiredTokens[index];
      const tokenId = tokenIds[index];
      if (result.status === 'fulfilled') {
        if (result.value === 'success') {
          successCount++;
        } else if (result.value === 'disable') {
          tokensToDisable.push(token);
          failCount++;
          failedTokenIds.push(tokenId);
        }
      } else {
        failCount++;
        failedTokenIds.push(tokenId);
      }
    });

    // 批量禁用失效的 token
    for (const token of tokensToDisable) {
      this.disableToken(token);
    }

    const elapsed = Date.now() - startTime;
    if (failCount > 0) {
      log.warn(`[GeminiCLI] 刷新完成: 成功 ${successCount}, 失败 ${failCount} (${failedTokenIds.join(', ')}), 耗时 ${elapsed}ms`);
    } else {
      log.info(`[GeminiCLI] 刷新完成: 成功 ${successCount}, 耗时 ${elapsed}ms`);
    }
  }

  /**
   * 安全刷新单个 token（不抛出异常）
   * @param {Object} token - Token 对象
   * @returns {Promise<'success'|'disable'|'skip'>} 刷新结果
   * @private
   */
  async _refreshTokenSafe(token) {
    try {
      await this.refreshToken(token, true);
      return 'success';
    } catch (error) {
      if (error.statusCode === 403 || error.statusCode === 400) {
        return 'disable';
      }
      throw error;
    }
  }

  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  _normalizeThresholdPolicy(input) {
    const base = cloneThresholdPolicy(DEFAULT_THRESHOLD_POLICY);
    if (!input || typeof input !== 'object') return base;

    if (typeof input.enabled === 'boolean') {
      base.enabled = input.enabled;
    }

    base.modelGroupPercent = clampPercent(input.modelGroupPercent, base.modelGroupPercent);
    base.globalPercent = clampPercent(input.globalPercent, base.globalPercent);

    if (input.applyStrategies && typeof input.applyStrategies === 'object') {
      const allowedKeys = ['round_robin', 'request_count', 'quota_exhausted'];
      for (const key of allowedKeys) {
        if (typeof input.applyStrategies[key] === 'boolean') {
          base.applyStrategies[key] = input.applyStrategies[key];
        }
      }
    }

    if (input.allBelowThresholdAction === 'strict' || input.allBelowThresholdAction === 'fail_open') {
      base.allBelowThresholdAction = input.allBelowThresholdAction;
    }

    return base;
  }

  _mergeThresholdPolicy(globalPolicyInput, cliPolicyInput) {
    const globalPolicy = this._normalizeThresholdPolicy(globalPolicyInput);
    if (!cliPolicyInput || typeof cliPolicyInput !== 'object') {
      return globalPolicy;
    }

    return this._normalizeThresholdPolicy({
      ...globalPolicy,
      ...cliPolicyInput,
      applyStrategies: {
        ...globalPolicy.applyStrategies,
        ...(cliPolicyInput.applyStrategies && typeof cliPolicyInput.applyStrategies === 'object'
          ? cliPolicyInput.applyStrategies
          : {})
      }
    });
  }

  // 加载轮询策略配置
  loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      // 优先使用 geminicli 专属配置，否则使用全局配置
      const globalRotation = jsonConfig.rotation || {};
      const cliRotation = jsonConfig.geminicli?.rotation || {};
      const rotationConfig = Object.keys(cliRotation).length > 0 ? cliRotation : globalRotation;

      this.rotationStrategy = rotationConfig.strategy || RotationStrategy.ROUND_ROBIN;
      this.requestCountPerToken = rotationConfig.requestCount || 10;
      this.thresholdPolicy = this._mergeThresholdPolicy(
        globalRotation.thresholdPolicy,
        cliRotation.thresholdPolicy
      );
    } catch (error) {
      log.warn('[GeminiCLI] 加载轮询配置失败，使用默认值:', error.message);
    }
  }

  // 更新轮询策略（热更新）
  updateRotationConfig(strategy, requestCount, thresholdPolicy = undefined) {
    if (strategy && Object.values(RotationStrategy).includes(strategy)) {
      this.rotationStrategy = strategy;
    }
    if (requestCount && requestCount > 0) {
      this.requestCountPerToken = requestCount;
    }
    if (thresholdPolicy !== undefined) {
      this.thresholdPolicy = this._normalizeThresholdPolicy(thresholdPolicy);
    }
    this.tokenRequestCounts.clear();
    if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
      log.info(`[GeminiCLI] 轮询策略已更新: ${this.rotationStrategy}, 每token请求 ${this.requestCountPerToken} 次后切换`);
    } else {
      log.info(`[GeminiCLI] 轮询策略已更新: ${this.rotationStrategy}`);
    }
  }

  /**
   * 检查 Token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - TOKEN_REFRESH_BUFFER;
  }

  /**
   * 刷新 Token
   * 使用 GEMINICLI_OAUTH_CONFIG 而非 OAUTH_CONFIG
   */
  async refreshToken(token, silent = false) {
    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(token.refresh_token, salt);
    if (!silent) {
      log.info(`[GeminiCLI] 正在刷新token: ${tokenId}`);
    }

    const body = new URLSearchParams({
      client_id: GEMINICLI_OAUTH_CONFIG.CLIENT_ID,
      client_secret: GEMINICLI_OAUTH_CONFIG.CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    try {
      const response = await axios(buildAxiosRequestConfig({
        method: 'POST',
        url: GEMINICLI_OAUTH_CONFIG.TOKEN_URL,
        headers: {
          'Host': 'oauth2.googleapis.com',
          'User-Agent': 'google-oauth-playground',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept-Encoding': 'gzip'
        },
        data: body.toString()
      }));

      token.access_token = response.data.access_token;
      token.expires_in = response.data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile(token);
      return token;
    } catch (error) {
      const statusCode = error.response?.status;
      const rawBody = error.response?.data;
      const message = typeof rawBody === 'string' ? rawBody : (rawBody?.error?.message || error.message || '刷新 token 失败');
      throw new TokenError(message, tokenId, statusCode || 500);
    }
  }

  saveToFile(tokenToUpdate = null) {
    this.store.mergeActiveTokens(this.tokens, tokenToUpdate).catch((error) => {
      log.error('[GeminiCLI] 保存账号配置文件失败:', error.message);
    });
  }

  disableToken(token) {
    log.warn(`[GeminiCLI] 禁用token ...${token.access_token.slice(-8)}`);
    token.enable = false;
    this.saveToFile();
    this.tokenRequestCounts.delete(token.refresh_token);
    this.tokens = this.tokens.filter(t => t.refresh_token !== token.refresh_token);
    this.currentIndex = this.currentIndex % Math.max(this.tokens.length, 1);
  }

  // 原子操作：获取并递增请求计数
  incrementRequestCount(tokenKey) {
    const current = this.tokenRequestCounts.get(tokenKey) || 0;
    const newCount = current + 1;
    this.tokenRequestCounts.set(tokenKey, newCount);
    return newCount;
  }

  // 原子操作：重置请求计数
  resetRequestCount(tokenKey) {
    this.tokenRequestCounts.set(tokenKey, 0);
  }

  /**
   * 通过 loadCodeAssist API 获取 projectId
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} projectId 或 null
   */
  async fetchProjectId(token) {
    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(token.refresh_token, salt);
    log.info(`[GeminiCLI] 正在获取 projectId: ${tokenId}`);

    const geminicliConfig = config.geminicli?.api || {};
    const baseUrl = geminicliConfig.baseUrl || GEMINICLI_API_CONFIG.BASE_URL;
    const url = `${baseUrl}/v1internal:loadCodeAssist`;

    const headers = {
      'Host': geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
      'User-Agent': geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };

    const requestBody = {
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    try {
      const response = await httpRequest({
        method: 'POST',
        url,
        headers,
        data: requestBody,
        timeout: 30000
      });

      const data = response.data;
      
      // 检查是否有 currentTier（表示用户已激活）
      if (data.currentTier) {
        const projectId = data.cloudaicompanionProject;
        if (projectId) {
          log.info(`[GeminiCLI] 成功获取 projectId: ${projectId}`);
          return projectId;
        }
        log.warn('[GeminiCLI] loadCodeAssist 响应中无 projectId');
        return null;
      }

      // 用户未激活，尝试 onboardUser
      log.info('[GeminiCLI] 用户未激活，尝试 onboardUser...');
      return await this._tryOnboardUser(token, data);
    } catch (error) {
      const status = error.response?.status || error.status || 500;
      log.error(`[GeminiCLI] 获取 projectId 失败 (${status}):`, error.message);
      
      if (status === 403 || status === 401) {
        throw new TokenError('Token 无权限获取 projectId', tokenId, status);
      }
      throw new TokenError(`获取 projectId 失败: ${error.message}`, tokenId, status);
    }
  }

  /**
   * 尝试通过 onboardUser 获取 projectId（长时间运行操作）
   * @param {Object} token - Token 对象
   * @param {Object} loadCodeAssistData - loadCodeAssist 的响应数据
   * @returns {Promise<string|null>} projectId 或 null
   * @private
   */
  async _tryOnboardUser(token, loadCodeAssistData) {
    const geminicliConfig = config.geminicli?.api || {};
    const baseUrl = geminicliConfig.baseUrl || GEMINICLI_API_CONFIG.BASE_URL;
    const url = `${baseUrl}/v1internal:onboardUser`;

    const headers = {
      'Host': geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
      'User-Agent': geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };

    // 从 loadCodeAssist 响应中获取默认 tier
    let tierId = 'LEGACY';
    const allowedTiers = loadCodeAssistData?.allowedTiers || [];
    for (const tier of allowedTiers) {
      if (tier.isDefault) {
        tierId = tier.id;
        break;
      }
    }

    const requestBody = {
      tierId,
      metadata: {
        ideType: 'ANTIGRAVITY',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI'
      }
    };

    // onboardUser 是长时间运行操作，需要轮询
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      log.debug(`[GeminiCLI] onboardUser 轮询 ${attempt}/${maxAttempts}`);

      try {
        const response = await httpRequest({
          method: 'POST',
          url,
          headers,
          data: requestBody,
          timeout: 30000
        });

        const data = response.data;

        if (data.done) {
          const responseData = data.response || {};
          const projectObj = responseData.cloudaicompanionProject;

          let projectId = null;
          if (typeof projectObj === 'object' && projectObj !== null) {
            projectId = projectObj.id;
          } else if (typeof projectObj === 'string') {
            projectId = projectObj;
          }

          if (projectId) {
            log.info(`[GeminiCLI] onboardUser 成功获取 projectId: ${projectId}`);
            return projectId;
          }
          log.warn('[GeminiCLI] onboardUser 完成但响应中无 projectId');
          return null;
        }

        // 操作未完成，等待后重试
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        log.error(`[GeminiCLI] onboardUser 失败:`, error.message);
        throw error;
      }
    }

    log.error('[GeminiCLI] onboardUser 超时');
    return null;
  }

  /**
   * 准备单个 token（刷新 + 获取 projectId）
   * @param {Object} token - Token 对象
   * @returns {Promise<'ready'|'disable'>} 处理结果
   * @private
   */
  async _prepareToken(token) {
    // 刷新过期的 token
    if (this.isExpired(token)) {
      await this.refreshToken(token);
    }

    // 获取 projectId（如果没有）
    if (!token.projectId) {
      const projectId = await this.fetchProjectId(token);
      if (!projectId) {
        log.warn(`[GeminiCLI] 无法获取 projectId，禁用账号`);
        return 'disable';
      }
      token.projectId = projectId;
      this.saveToFile(token);
    }

    return 'ready';
  }

  /**
   * 处理 token 准备过程中的错误
   * @param {Error} error - 错误对象
   * @param {Object} token - Token 对象
   * @returns {'disable'|'skip'} 处理结果
   * @private
   */
  _handleTokenError(error, token) {
    const suffix = token.access_token?.slice(-8) || 'unknown';
    if (error.statusCode === 403 || error.statusCode === 400) {
      log.warn(`[GeminiCLI] ...${suffix}: Token 已失效或错误，已自动禁用该账号`);
      return 'disable';
    }
    log.error(`[GeminiCLI] ...${suffix} 操作失败:`, error.message);
    return 'skip';
  }

  _shouldApplyThresholdForStrategy(strategy) {
    const policy = this.thresholdPolicy;
    if (!policy?.enabled) return false;
    const map = policy.applyStrategies || {};
    return map[strategy] === true;
  }

  async _getTokenIdAsync(token) {
    if (!token?.refresh_token) return null;
    try {
      const salt = this.store._salt || await this.store.getSalt();
      if (!salt) return null;
      return generateTokenId(token.refresh_token, salt);
    } catch {
      return null;
    }
  }

  _buildQuotaFetchUrl() {
    const geminicliConfig = config.geminicli?.api || {};
    if (geminicliConfig.modelsUrl) return geminicliConfig.modelsUrl;
    const host = geminicliConfig.host || GEMINICLI_API_CONFIG.HOST;
    return `https://${host}/v1internal:fetchAvailableModels`;
  }

  _buildQuotaFetchHeaders(token) {
    const geminicliConfig = config.geminicli?.api || {};
    return {
      'Host': geminicliConfig.host || GEMINICLI_API_CONFIG.HOST,
      'User-Agent': geminicliConfig.userAgent || GEMINICLI_API_CONFIG.USER_AGENT,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    };
  }

  async _fetchModelsWithQuotas(token) {
    const response = await httpRequest({
      method: 'POST',
      url: this._buildQuotaFetchUrl(),
      headers: this._buildQuotaFetchHeaders(token),
      data: {}
    });

    const data = response.data || {};
    const quotas = {};
    Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
      if (modelData?.quotaInfo) {
        quotas[modelId] = {
          r: modelData.quotaInfo.remainingFraction,
          t: modelData.quotaInfo.resetTime
        };
      }
    });
    return quotas;
  }

  async _refreshQuotaSync(token, tokenId) {
    if (!tokenId) return false;
    if (this.quotaRefreshInFlight.has(tokenId)) {
      return this.quotaRefreshInFlight.get(tokenId);
    }

    const task = (async () => {
      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token, true);
        }
        const quotas = await this._fetchModelsWithQuotas(token);
        quotaManager.updateQuota(tokenId, quotas);
        return true;
      } catch (error) {
        log.warn(`[GeminiCLI] 刷新额度失败(${tokenId}): ${error.message}`);
        return false;
      } finally {
        this.quotaRefreshInFlight.delete(tokenId);
      }
    })();

    this.quotaRefreshInFlight.set(tokenId, task);
    return task;
  }

  _refreshQuotaAsync(token, tokenId) {
    if (!tokenId) return;
    if (this.quotaRefreshInFlight.has(tokenId)) return;
    void this._refreshQuotaSync(token, tokenId);
  }

  async _ensureQuotaForThreshold(token, tokenId) {
    if (!tokenId) return;
    const fresh = quotaManager.getQuota(tokenId);
    if (fresh) return;

    const stale = quotaManager.getQuotaAnyAge(tokenId);
    if (!stale) {
      await this._refreshQuotaSync(token, tokenId);
      return;
    }

    this._refreshQuotaAsync(token, tokenId);
  }

  async _evaluateThreshold(token, modelId) {
    const policy = this.thresholdPolicy;
    if (!policy?.enabled || !modelId) {
      return { pass: true, reason: 'disabled' };
    }

    const tokenId = await this._getTokenIdAsync(token);
    if (!tokenId) {
      return { pass: true, reason: 'no_token_id' };
    }

    await this._ensureQuotaForThreshold(token, tokenId);

    if (!quotaManager.hasQuotaData(tokenId)) {
      return { pass: true, reason: 'no_quota_data' };
    }

    const modelGroupRemaining = quotaManager.getModelGroupQuota(tokenId, modelId);
    const globalMin = quotaManager.getGlobalMinQuota(tokenId);
    const globalRemaining = globalMin.hasData ? globalMin.remaining : 1;

    const groupThreshold = policy.modelGroupPercent / 100;
    const globalThreshold = policy.globalPercent / 100;

    const groupBlocked = modelGroupRemaining <= groupThreshold;
    const globalBlocked = globalRemaining <= globalThreshold;
    if (!groupBlocked && !globalBlocked) {
      return {
        pass: true,
        modelGroupRemaining,
        globalRemaining
      };
    }

    return {
      pass: false,
      reason: groupBlocked && globalBlocked ? 'group_and_global' : (groupBlocked ? 'group' : 'global'),
      modelGroupRemaining,
      globalRemaining,
      groupThreshold,
      globalThreshold
    };
  }

  async _checkThresholdAndCollectFallback(token, modelId, fallbackCandidates, tokenIndex) {
    const thresholdResult = await this._evaluateThreshold(token, modelId);
    if (thresholdResult.pass) return true;

    if (this.thresholdPolicy.allBelowThresholdAction === 'fail_open') {
      fallbackCandidates.push(tokenIndex);
    }
    return false;
  }

  async _tryGetFallbackToken(fallbackCandidates, strategy = this.rotationStrategy) {
    for (const tokenIndex of fallbackCandidates) {
      const token = this.tokens[tokenIndex];
      if (!token) continue;
      try {
        const result = await this._prepareToken(token);
        if (result === 'disable') {
          this.disableToken(token);
          continue;
        }

        this.currentIndex = tokenIndex;
        if (strategy === RotationStrategy.ROUND_ROBIN) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        } else if (strategy === RotationStrategy.REQUEST_COUNT) {
          const tokenKey = token.refresh_token;
          const count = this.tokenRequestCounts.get(tokenKey) || 0;
          if (count >= this.requestCountPerToken) {
            this.resetRequestCount(tokenKey);
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
          }
        }
        return token;
      } catch (error) {
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
        }
      }
    }
    return null;
  }

  /**
   * 获取可用的 token
   * @param {string|null} modelId - 请求模型ID（用于阈值判断）
   * @param {Object} [options]
   * @param {boolean} [options.bypassThreshold=false] - 是否跳过阈值过滤
   * @returns {Promise<Object|null>} token 对象
   */
  async getToken(modelId = null, options = {}) {
    await this._ensureInitialized();
    if (this.tokens.length === 0) return null;

    const totalTokens = this.tokens.length;
    const startIndex = this.currentIndex;
    const applyThreshold = modelId &&
      options.bypassThreshold !== true &&
      this._shouldApplyThresholdForStrategy(this.rotationStrategy);
    const fallbackCandidates = [];
    let thresholdCheckedCount = 0;
    let thresholdFilteredCount = 0;

    for (let i = 0; i < totalTokens; i++) {
      const index = (startIndex + i) % totalTokens;
      const token = this.tokens[index];

      if (applyThreshold) {
        thresholdCheckedCount++;
        const pass = await this._checkThresholdAndCollectFallback(token, modelId, fallbackCandidates, index);
        if (!pass) {
          thresholdFilteredCount++;
          continue;
        }
      }

      try {
        const result = await this._prepareToken(token);
        if (result === 'disable') {
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
          continue;
        }

        // 更新当前索引
        this.currentIndex = index;

        // 根据策略决定是否切换
        if (this.rotationStrategy === RotationStrategy.ROUND_ROBIN) {
          this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        } else if (this.rotationStrategy === RotationStrategy.REQUEST_COUNT) {
          const tokenKey = token.refresh_token;
          const count = this.tokenRequestCounts.get(tokenKey) || 0;
          if (count >= this.requestCountPerToken) {
            this.resetRequestCount(tokenKey);
            this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
          }
        }

        return token;
      } catch (error) {
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
          if (this.tokens.length === 0) return null;
        }
        // skip: 继续尝试下一个 token
      }
    }

    const allBelowThreshold = thresholdCheckedCount > 0 && thresholdFilteredCount === thresholdCheckedCount;
    if (applyThreshold && allBelowThreshold) {
      if (this.thresholdPolicy.allBelowThresholdAction === 'fail_open') {
        log.warn(`[GeminiCLI] 阈值策略触发保底放行: 模型 ${modelId} 所有候选凭证均低于阈值，尝试保底选取`);
        return this._tryGetFallbackToken(fallbackCandidates, this.rotationStrategy);
      }
      log.warn(`[GeminiCLI] 阈值策略严格模式生效: 模型 ${modelId} 所有候选凭证均低于阈值，返回无可用凭证`);
      return null;
    }

    return null;
  }

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
    }
  }

  // API管理方法
  async reload() {
    this._initPromise = this._initialize();
    await this._initPromise;
    log.info('[GeminiCLI] Token已热重载');
  }

  async addToken(tokenData) {
    try {
      const allTokens = await this.store.readAll();

      const newToken = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_in: tokenData.expires_in || 3599,
        timestamp: tokenData.timestamp || Date.now(),
        enable: tokenData.enable !== undefined ? tokenData.enable : true,
        useThreshold: tokenData.useThreshold !== undefined
          ? tokenData.useThreshold
          : DEFAULT_TOKEN_THRESHOLD_CONTROL.useThreshold,
        allowBypassWithSpecialKey: tokenData.allowBypassWithSpecialKey !== undefined
          ? tokenData.allowBypassWithSpecialKey
          : DEFAULT_TOKEN_THRESHOLD_CONTROL.allowBypassWithSpecialKey
      };

      if (tokenData.email) {
        newToken.email = tokenData.email;
      }

      if (tokenData.projectId) {
        newToken.projectId = tokenData.projectId;
      }

      allTokens.push(newToken);
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: 'Token添加成功' };
    } catch (error) {
      log.error('[GeminiCLI] 添加Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async updateToken(refreshToken, updates) {
    try {
      const allTokens = await this.store.readAll();

      const index = allTokens.findIndex(t => t.refresh_token === refreshToken);
      if (index === -1) {
        return { success: false, message: 'Token不存在' };
      }

      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('[GeminiCLI] 更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async deleteToken(refreshToken) {
    try {
      const allTokens = await this.store.readAll();

      const filteredTokens = allTokens.filter(t => t.refresh_token !== refreshToken);
      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: 'Token不存在' };
      }

      await this.store.writeAll(filteredTokens);

      await this.reload();
      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('[GeminiCLI] 删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  async getTokenList() {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      return allTokens.map(token => ({
        ...normalizeTokenThresholdControl(token),
        id: generateTokenId(token.refresh_token, salt),
        expires_in: token.expires_in,
        timestamp: token.timestamp,
        enable: token.enable !== false,
        email: token.email || null,
        projectId: token.projectId || null
      }));
    } catch (error) {
      log.error('[GeminiCLI] 获取Token列表失败:', error.message);
      return [];
    }
  }

  /**
   * 根据 tokenId 获取并更新 projectId
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 包含 projectId 的结果
   */
  async fetchProjectIdForToken(tokenId) {
    const tokenData = await this.findTokenById(tokenId);
    if (!tokenData) {
      throw new TokenError('Token不存在', null, 404);
    }

    // 确保 token 未过期
    if (this.isExpired(tokenData)) {
      await this.refreshToken(tokenData);
    }

    const projectId = await this.fetchProjectId(tokenData);
    if (!projectId) {
      throw new TokenError('无法获取 projectId，该账号可能无资格', null, 400);
    }

    // 更新并保存
    tokenData.projectId = projectId;
    
    // 更新文件
    const allTokens = await this.store.readAll();
    const salt = await this.store.getSalt();
    const index = allTokens.findIndex(t =>
      generateTokenId(t.refresh_token, salt) === tokenId
    );
    if (index !== -1) {
      allTokens[index].projectId = projectId;
      await this.store.writeAll(allTokens);
    }

    // 更新内存中的 token
    const memoryToken = this.tokens.find(t => t.refresh_token === tokenData.refresh_token);
    if (memoryToken) {
      memoryToken.projectId = projectId;
    }

    return { projectId };
  }

  /**
   * 根据 tokenId 查找完整的 token 对象
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async findTokenById(tokenId) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      return allTokens.find(token =>
        generateTokenId(token.refresh_token, salt) === tokenId
      ) || null;
    } catch (error) {
      log.error('[GeminiCLI] 查找Token失败:', error.message);
      return null;
    }
  }

  /**
   * 根据 tokenId 更新 token
   * @param {string} tokenId - 安全的 token ID
   * @param {Object} updates - 更新内容
   * @returns {Promise<Object>} 操作结果
   */
  async updateTokenById(tokenId, updates) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      const index = allTokens.findIndex(token =>
        generateTokenId(token.refresh_token, salt) === tokenId
      );

      if (index === -1) {
        return { success: false, message: 'Token不存在' };
      }

      allTokens[index] = { ...allTokens[index], ...updates };
      await this.store.writeAll(allTokens);

      await this.reload();
      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('[GeminiCLI] 更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 删除 token
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 操作结果
   */
  async deleteTokenById(tokenId) {
    try {
      const allTokens = await this.store.readAll();
      const salt = await this.store.getSalt();

      const filteredTokens = allTokens.filter(token =>
        generateTokenId(token.refresh_token, salt) !== tokenId
      );

      if (filteredTokens.length === allTokens.length) {
        return { success: false, message: 'Token不存在' };
      }

      await this.store.writeAll(filteredTokens);

      await this.reload();
      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('[GeminiCLI] 删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 刷新 token
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<Object>} 刷新后的 token 信息（不含敏感数据）
   */
  async refreshTokenById(tokenId) {
    const tokenData = await this.findTokenById(tokenId);
    if (!tokenData) {
      throw new TokenError('Token不存在', null, 404);
    }

    const refreshedToken = await this.refreshToken(tokenData);
    return {
      expires_in: refreshedToken.expires_in,
      timestamp: refreshedToken.timestamp
    };
  }

  /**
   * 获取盐值
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    return this.store.getSalt();
  }

  // 获取当前轮询配置
  getRotationConfig() {
    return {
      strategy: this.rotationStrategy,
      requestCount: this.requestCountPerToken,
      thresholdPolicy: cloneThresholdPolicy(this.thresholdPolicy),
      currentIndex: this.currentIndex,
      tokenCounts: Object.fromEntries(this.tokenRequestCounts)
    };
  }
}

// 导出策略枚举
export { RotationStrategy };

const geminicliTokenManager = new GeminiCliTokenManager();
export default geminicliTokenManager;

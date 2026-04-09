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
import tokenCooldownManager from './token_cooldown_manager.js';
import { getGroupKey } from '../utils/modelGroups.js';

// Gemini CLI API 配置
const GEMINICLI_API_CONFIG = {
  HOST: 'cloudcode-pa.googleapis.com',
  USER_AGENT: 'GeminiCLI/0.34.0 (Windows; AMD64)',
  BASE_URL: 'https://cloudcode-pa.googleapis.com'
};

// Subscription tier 映射表（raw tier → 标准化）
const TIER_MAP = {
  'g1-ultra-tier': 'ultra',
  'ws-ai-ultra-business-tier': 'ultra',
  'g1-pro-tier': 'pro',
  'helium-tier': 'pro',
  'standard-tier': 'free',
  'free-tier': 'free',
};

function mapRawTier(rawTier) {
  if (!rawTier) return 'pro';
  return TIER_MAP[rawTier.toLowerCase()] || 'pro';
}

export const GEMINICLI_TOKEN_STATUS = Object.freeze({
  READY: 'ready',
  PENDING: 'pending',
  INVALID: 'invalid'
});

export const GEMINICLI_PENDING_STAGE = Object.freeze({
  OAUTH_EXCHANGED: 'oauth_exchanged',
  PROJECT_ID: 'project_id',
  ENABLE_APIS: 'enable_apis',
  PREVIEW_PROBE: 'preview_probe'
});

export const GEMINICLI_PREVIEW_CAPABILITY = Object.freeze({
  UNKNOWN: 'unknown',
  SUPPORTED: 'supported',
  UNSUPPORTED: 'unsupported'
});

const GEMINICLI_PENDING_STAGES = new Set(Object.values(GEMINICLI_PENDING_STAGE));
const GEMINICLI_TOKEN_STATUSES = new Set(Object.values(GEMINICLI_TOKEN_STATUS));
const GEMINICLI_PREVIEW_CAPABILITIES = new Set(Object.values(GEMINICLI_PREVIEW_CAPABILITY));
const GEMINICLI_REQUIRED_SERVICES = Object.freeze([
  'geminicloudassist.googleapis.com',
  'cloudaicompanion.googleapis.com',
]);
const GEMINICLI_PREVIEW_PROBE_MODEL = 'gemini-3-flash-preview';

function normalizeTier(value, fallback = 'pro') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ultra' || normalized === 'pro' || normalized === 'free') {
    return normalized;
  }
  return fallback;
}

function normalizeStatus(value, fallback = GEMINICLI_TOKEN_STATUS.PENDING) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return GEMINICLI_TOKEN_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizePendingStageValue(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return GEMINICLI_PENDING_STAGES.has(normalized) ? normalized : fallback;
}

function normalizePreviewCapability(value, fallback = GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN) {
  if (typeof value === 'boolean') {
    return value ? GEMINICLI_PREVIEW_CAPABILITY.SUPPORTED : GEMINICLI_PREVIEW_CAPABILITY.UNSUPPORTED;
  }
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  return GEMINICLI_PREVIEW_CAPABILITIES.has(normalized) ? normalized : fallback;
}

function normalizeLastAttemptAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRepairCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.floor(count);
}

function normalizeTokenErrorMessage(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function deriveStoredStatus(token) {
  const explicitStatus = normalizeStatus(token?.status, null);
  if (explicitStatus) {
    if (explicitStatus === GEMINICLI_TOKEN_STATUS.READY && !token?.projectId) {
      return GEMINICLI_TOKEN_STATUS.PENDING;
    }
    return explicitStatus;
  }
  if (token?.projectId) return GEMINICLI_TOKEN_STATUS.READY;
  return GEMINICLI_TOKEN_STATUS.PENDING;
}

function isPreviewModelId(modelId) {
  return typeof modelId === 'string' && modelId.toLowerCase().includes('preview');
}

function buildPreviewProbeUrl(geminicliConfig = {}) {
  return geminicliConfig.noStreamUrl || 'https://cloudcode-pa.googleapis.com/v1internal:generateContent';
}

function normalizeBooleanLike(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
    if (normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  }
  if (value === false || value === 0 || value === '0') return false;
  return undefined;
}

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
  crossModelGlobalBlock: false,
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
    crossModelGlobalBlock: policy.crossModelGlobalBlock,
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
    /** @type {number[]} */
    this.availableQuotaTokenIndices = [];
    /** @type {number} */
    this.currentQuotaIndex = 0;

    /** @type {Promise<void>|null} */
    this._initPromise = null;
  }

  _normalizeStoredToken(token) {
    const normalized = GeminiCliTokenManager.normalizeCredentialFormat(token);
    const status = deriveStoredStatus(normalized);
    const pendingStage = status === GEMINICLI_TOKEN_STATUS.PENDING
      ? normalizePendingStageValue(
        normalized.pendingStage,
        normalized.projectId ? GEMINICLI_PENDING_STAGE.ENABLE_APIS : GEMINICLI_PENDING_STAGE.PROJECT_ID
      )
      : null;

    return {
      ...normalized,
      ...normalizeTokenThresholdControl(normalized),
      enable: normalized.enable !== false,
      hasQuota: normalized.hasQuota !== false,
      tier: normalizeTier(normalized.tier, 'pro'),
      status,
      pendingStage,
      lastError: normalizeTokenErrorMessage(normalized.lastError),
      lastAttemptAt: normalizeLastAttemptAt(normalized.lastAttemptAt),
      repairCount: normalizeRepairCount(normalized.repairCount),
      previewCapability: normalizePreviewCapability(
        normalized.previewCapability ?? normalized.preview,
        GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN
      )
    };
  }

  async _loadNormalizedTokens() {
    const rawTokens = await this.store.readAll();
    const normalizedTokens = rawTokens.map((token) => this._normalizeStoredToken(token));
    const changed = JSON.stringify(rawTokens) !== JSON.stringify(normalizedTokens);
    if (changed) {
      await this.store.writeAll(normalizedTokens);
    }
    return normalizedTokens;
  }

  _isReadyToken(token) {
    return token?.enable !== false && token?.status === GEMINICLI_TOKEN_STATUS.READY;
  }

  _shouldAutoRepairToken(token) {
    return token?.enable !== false && token?.status === GEMINICLI_TOKEN_STATUS.PENDING;
  }

  _getPreviewPriority(token, modelId) {
    const capability = normalizePreviewCapability(token?.previewCapability, GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN);
    if (isPreviewModelId(modelId)) {
      if (capability === GEMINICLI_PREVIEW_CAPABILITY.SUPPORTED) return 0;
      if (capability === GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN) return 1;
      return 2;
    }

    if (capability === GEMINICLI_PREVIEW_CAPABILITY.UNSUPPORTED) return 0;
    if (capability === GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN) return 1;
    return 2;
  }

  _buildOrderedCandidateIndices(indices, modelId) {
    return indices
      .map((tokenIndex, order) => ({
        tokenIndex,
        order,
        priority: this._getPreviewPriority(this.tokens[tokenIndex], modelId)
      }))
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .map((item) => item.tokenIndex);
  }

  async _persistTokenRecord(token) {
    const allTokens = await this.store.readAll();
    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(token.refresh_token, salt);
    const index = allTokens.findIndex((entry) =>
      generateTokenId(entry.refresh_token, salt) === tokenId
    );
    if (index !== -1) {
      allTokens[index] = { ...allTokens[index], ...token };
      await this.store.writeAll(allTokens);
    }
  }

  _applyLifecycleState(token, {
    status,
    pendingStage = null,
    lastError = null,
    lastAttemptAt = Date.now(),
    incrementRepairCount = false
  } = {}) {
    if (status) token.status = normalizeStatus(status, GEMINICLI_TOKEN_STATUS.PENDING);
    token.pendingStage = token.status === GEMINICLI_TOKEN_STATUS.PENDING
      ? normalizePendingStageValue(pendingStage, GEMINICLI_PENDING_STAGE.PROJECT_ID)
      : null;
    token.lastError = normalizeTokenErrorMessage(lastError);
    token.lastAttemptAt = normalizeLastAttemptAt(lastAttemptAt);
    if (incrementRepairCount) {
      token.repairCount = normalizeRepairCount(token.repairCount) + 1;
    } else {
      token.repairCount = normalizeRepairCount(token.repairCount);
    }
  }

  async _markTokenReady(token, { previewCapability = null } = {}) {
    if (previewCapability) {
      token.previewCapability = normalizePreviewCapability(previewCapability, token.previewCapability);
    } else {
      token.previewCapability = normalizePreviewCapability(
        token.previewCapability,
        GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN
      );
    }
    this._applyLifecycleState(token, {
      status: GEMINICLI_TOKEN_STATUS.READY,
      pendingStage: null,
      lastError: null
    });
    await this._persistTokenRecord(token);
  }

  async _markTokenPending(token, stage, errorMessage) {
    this._applyLifecycleState(token, {
      status: GEMINICLI_TOKEN_STATUS.PENDING,
      pendingStage: stage,
      lastError: errorMessage
    });
    await this._persistTokenRecord(token);
  }

  async _markTokenInvalid(token, errorMessage) {
    this._applyLifecycleState(token, {
      status: GEMINICLI_TOKEN_STATUS.INVALID,
      pendingStage: null,
      lastError: errorMessage
    });
    await this._persistTokenRecord(token);
  }

  async _initialize() {
    try {
      log.info('[GeminiCLI] 正在初始化token管理器...');
      const tokenArray = await this._loadNormalizedTokens();
      await this.store.getSalt();

      this.tokens = tokenArray.filter(token => token.enable !== false).map(token => ({
        ...token
      }));
      this._totalTokenCount = tokenArray.length;

      this.currentIndex = 0;
      this.tokenRequestCounts.clear();
      this._rebuildAvailableQuotaTokens();
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
        await this._autoRepairPendingTokens('initialize');
      }
    } catch (error) {
      log.error('[GeminiCLI] 初始化token失败:', error.message);
      this.tokens = [];
    }
  }

  _rebuildAvailableQuotaTokens() {
    this.availableQuotaTokenIndices = [];
    this.tokens.forEach((token, index) => {
      if (this._isReadyToken(token) && token.hasQuota !== false) {
        this.availableQuotaTokenIndices.push(index);
      }
    });

    if (this.availableQuotaTokenIndices.length === 0) {
      this.currentQuotaIndex = 0;
    } else {
      this.currentQuotaIndex = this.currentQuotaIndex % this.availableQuotaTokenIndices.length;
    }
  }

  _removeQuotaIndex(tokenIndex) {
    const pos = this.availableQuotaTokenIndices.indexOf(tokenIndex);
    if (pos !== -1) {
      this.availableQuotaTokenIndices.splice(pos, 1);
      if (this.currentQuotaIndex >= this.availableQuotaTokenIndices.length) {
        this.currentQuotaIndex = 0;
      }
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
    if (typeof input.crossModelGlobalBlock === 'boolean') {
      base.crossModelGlobalBlock = input.crossModelGlobalBlock;
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
  async refreshToken(token, silent = false, options = {}) {
    const { skipLifecycleRepair = false } = options;
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
      if (!skipLifecycleRepair && token.status === GEMINICLI_TOKEN_STATUS.PENDING) {
        await this._repairTokenLifecycle(token, {
          trigger: 'refresh',
          incrementRepairCount: true
        });
      }
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
    this._rebuildAvailableQuotaTokens();
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
   * 记录一次请求（用于请求计数策略和额度预估）
   * @param {Object} token - Token 对象
   * @param {string|null} modelId - 使用的模型 ID
   */
  async recordRequest(token, modelId = null) {
    if (!token) return;

    if (token.refresh_token) {
      this.incrementRequestCount(token.refresh_token);
    }

    if (!modelId) return;

    try {
      const salt = await this.store.getSalt();
      const tokenId = generateTokenId(token.refresh_token, salt);
      quotaManager.recordRequest(tokenId, modelId);
    } catch (error) {
      log.warn('[GeminiCLI] 记录请求次数失败:', error.message);
    }
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
      
      // 提取订阅等级（优先 paidTier，其次 currentTier）
      const rawTier = data.paidTier?.id || data.currentTier?.id || null;
      const tier = mapRawTier(rawTier);
      if (rawTier) {
        log.info(`[GeminiCLI] Raw tier '${rawTier}' → '${tier}'`);
      }

      // 检查是否有 currentTier（表示用户已激活）
      if (data.currentTier) {
        const projectId = data.cloudaicompanionProject;
        if (projectId) {
          log.info(`[GeminiCLI] 成功获取 projectId: ${projectId}, tier: ${tier}`);
          return { projectId, tier };
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
            return { projectId, tier: 'pro' };
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

  _isPermanentRefreshFailure(error) {
    const statusCode = error?.statusCode ?? error?.response?.status;
    if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return (
      message.includes('invalid_grant') ||
      message.includes('refresh token') ||
      message.includes('unauthorized_client') ||
      message.includes('access_denied')
    );
  }

  async _enableRequiredApis(token, projectId) {
    const failures = [];
    for (const service of GEMINICLI_REQUIRED_SERVICES) {
      try {
        const url = `https://serviceusage.googleapis.com/v1/projects/${projectId}/services/${service}:enable`;
        await axios(buildAxiosRequestConfig({
          method: 'POST',
          url,
          headers: {
            'Authorization': `Bearer ${token.access_token}`,
            'Content-Type': 'application/json',
          },
          data: '{}',
          timeout: 15000
        }));
        log.info(`[GeminiCLI] 已启用服务: ${service}`);
      } catch (error) {
        const status = error?.response?.status;
        const message = typeof error?.response?.data === 'string'
          ? error.response.data
          : (error?.response?.data?.error?.message || error.message || '未知错误');
        if (status === 400 && String(message).toLowerCase().includes('already enabled')) {
          continue;
        }
        failures.push(`${service}: ${message}`);
        log.warn(`[GeminiCLI] 启用服务失败 ${service}: ${message}`);
      }
    }

    return {
      ok: failures.length === 0,
      error: failures.length > 0 ? failures.join(' | ') : null
    };
  }

  async _probePreviewCapability(token) {
    if (!token?.projectId) {
      return {
        capability: GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN,
        error: '缺少 projectId，无法探测 preview 能力'
      };
    }

    const url = buildPreviewProbeUrl(config.geminicli?.api);
    const headers = this._buildQuotaFetchHeaders(token);
    const requestBody = {
      model: GEMINICLI_PREVIEW_PROBE_MODEL,
      project: token.projectId,
      request: {
        contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
        generationConfig: { maxOutputTokens: 1 }
      }
    };

    try {
      const response = await httpRequest({
        method: 'POST',
        url,
        headers,
        data: requestBody,
        timeout: 20000
      });

      if (response.status === 404 || response.statusCode === 404) {
        return {
          capability: GEMINICLI_PREVIEW_CAPABILITY.UNSUPPORTED,
          error: 'preview 模型返回 404'
        };
      }

      return {
        capability: GEMINICLI_PREVIEW_CAPABILITY.SUPPORTED,
        error: null
      };
    } catch (error) {
      const status = error?.response?.status || error?.status || error?.statusCode;
      if (status === 404) {
        return {
          capability: GEMINICLI_PREVIEW_CAPABILITY.UNSUPPORTED,
          error: 'preview 模型返回 404'
        };
      }
      return {
        capability: GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN,
        error: error.message || 'preview 探测失败'
      };
    }
  }

  async _repairTokenLifecycle(token, { trigger = 'repair', incrementRepairCount = false } = {}) {
    this._applyLifecycleState(token, {
      status: token.status || GEMINICLI_TOKEN_STATUS.PENDING,
      pendingStage: token.pendingStage || GEMINICLI_PENDING_STAGE.OAUTH_EXCHANGED,
      lastError: token.lastError,
      lastAttemptAt: Date.now(),
      incrementRepairCount
    });

    try {
      if (this.isExpired(token)) {
        if (!token.refresh_token) {
          await this._markTokenInvalid(token, 'Token 已过期且缺少 refresh_token');
          return { ok: false, status: GEMINICLI_TOKEN_STATUS.INVALID, token };
        }
        try {
          await this.refreshToken(token, true, { skipLifecycleRepair: true });
        } catch (error) {
          if (this._isPermanentRefreshFailure(error)) {
            await this._markTokenInvalid(token, error.message || '刷新 Token 失败');
            return { ok: false, status: GEMINICLI_TOKEN_STATUS.INVALID, token };
          }
          await this._markTokenPending(token, GEMINICLI_PENDING_STAGE.OAUTH_EXCHANGED, error.message || '刷新 Token 失败');
          return { ok: false, status: GEMINICLI_TOKEN_STATUS.PENDING, token };
        }
      }

      if (!token.projectId) {
        const result = await this.fetchProjectId(token);
        if (!result?.projectId) {
          await this._markTokenPending(token, GEMINICLI_PENDING_STAGE.PROJECT_ID, '无法获取 projectId');
          return { ok: false, status: GEMINICLI_TOKEN_STATUS.PENDING, token };
        }
        token.projectId = result.projectId;
        token.tier = normalizeTier(result.tier, token.tier || 'pro');
      } else {
        token.tier = normalizeTier(token.tier, 'pro');
      }

      const enableResult = await this._enableRequiredApis(token, token.projectId);
      if (!enableResult.ok) {
        await this._markTokenPending(token, GEMINICLI_PENDING_STAGE.ENABLE_APIS, enableResult.error || '启用服务失败');
        return { ok: false, status: GEMINICLI_TOKEN_STATUS.PENDING, token };
      }

      token.previewCapability = normalizePreviewCapability(
        token.previewCapability,
        GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN
      );

      const probeResult = await this._probePreviewCapability(token);
      token.previewCapability = normalizePreviewCapability(
        probeResult.capability,
        GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN
      );
      if (probeResult.error) {
        token.lastError = probeResult.error;
      }

      await this._markTokenReady(token, { previewCapability: token.previewCapability });
      return {
        ok: true,
        status: GEMINICLI_TOKEN_STATUS.READY,
        token,
        trigger
      };
    } catch (error) {
      await this._markTokenPending(
        token,
        token.projectId ? GEMINICLI_PENDING_STAGE.ENABLE_APIS : GEMINICLI_PENDING_STAGE.PROJECT_ID,
        error.message || '修复失败'
      );
      return {
        ok: false,
        status: GEMINICLI_TOKEN_STATUS.PENDING,
        token,
        error: error.message || '修复失败'
      };
    }
  }

  async _autoRepairPendingTokens(trigger = 'auto') {
    const candidates = this.tokens.filter((token) => this._shouldAutoRepairToken(token));
    for (const token of candidates) {
      try {
        await this._repairTokenLifecycle(token, {
          trigger,
          incrementRepairCount: true
        });
      } catch (error) {
        log.warn(`[GeminiCLI] 自动修复 pending token 失败: ${error.message}`);
      }
    }
  }

  async repairTokenById(tokenId, trigger = 'manual') {
    const tokenData = await this.findTokenById(tokenId);
    if (!tokenData) {
      throw new TokenError('Token不存在', null, 404);
    }

    const normalized = this._normalizeStoredToken(tokenData);
    const result = await this._repairTokenLifecycle(normalized, {
      trigger,
      incrementRepairCount: true
    });

    await this.reload();
    return {
      status: result.status,
      pendingStage: normalized.pendingStage || null,
      projectId: normalized.projectId || null,
      tier: normalized.tier || 'pro',
      previewCapability: normalized.previewCapability || GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN,
      lastError: normalized.lastError || null,
      lastAttemptAt: normalized.lastAttemptAt || null,
      repairCount: normalized.repairCount || 0
    };
  }

  /**
   * 准备单个 token（刷新 + 获取 projectId）
   * @param {Object} token - Token 对象
   * @returns {Promise<'ready'|'disable'>} 处理结果
   * @private
   */
  async _prepareToken(token) {
    if (token.status !== GEMINICLI_TOKEN_STATUS.READY) {
      return 'skip';
    }

    // 刷新过期的 token
    if (this.isExpired(token)) {
      await this.refreshToken(token);
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

  _resetAllQuotas() {
    log.warn('[GeminiCLI] 所有 token 额度已耗尽，重置额度状态');
    this.tokens.forEach((token) => {
      token.hasQuota = true;
    });
    this.saveToFile();
    this._rebuildAvailableQuotaTokens();
  }

  _checkAllTokensExhaustedForModel(modelId) {
    if (!modelId || this.tokens.length === 0) return false;

    for (const token of this.tokens) {
      if (this._canUseTokenForModel(token, modelId)) {
        return false;
      }
    }
    return true;
  }

  _hasQuotaForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const salt = this.store._salt;
      if (!salt) return true;

      const tokenId = generateTokenId(token.refresh_token, salt);
      return quotaManager.hasQuotaForModel(tokenId, modelId);
    } catch {
      return true;
    }
  }

  _isTokenAvailableForModel(token, modelId) {
    if (!token || !modelId) return true;

    try {
      const tokenId = this.getTokenId(token);
      if (!tokenId) return true;
      return tokenCooldownManager.isAvailable(tokenId, modelId);
    } catch {
      return true;
    }
  }

  _canUseTokenForModel(token, modelId) {
    if (!token || !modelId) return true;
    if (!this._isReadyToken(token)) return false;

    // Tier 过滤：gemini-3.1-pro-preview 仅 pro/ultra 可用
    if (modelId && token.tier === 'free') {
      const lower = modelId.toLowerCase();
      if (lower.includes('gemini-3.1-pro-preview')) {
        return false;
      }
    }

    if (!this._isTokenAvailableForModel(token, modelId)) {
      return false;
    }
    return this._hasQuotaForModel(token, modelId);
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

  async refreshQuota(token) {
    const tokenId = await this._getTokenIdAsync(token);
    if (!tokenId) return false;
    return this._refreshQuotaSync(token, tokenId);
  }

  /**
   * 根据 tokenId 手动刷新额度
   * @param {string} tokenId - 安全的 token ID
   * @returns {Promise<boolean>} 是否成功
   */
  async refreshQuotaById(tokenId) {
    await this._ensureInitialized();
    let token = await this.findTokenById(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }
    const normalized = this._normalizeStoredToken(token);
    if (normalized.status === GEMINICLI_TOKEN_STATUS.PENDING) {
      const repairResult = await this.repairTokenById(tokenId, 'refresh_quota');
      if (repairResult.status !== GEMINICLI_TOKEN_STATUS.READY) {
        throw new TokenError(repairResult.lastError || 'Token 仍处于待修复状态', null, 400);
      }
      token = await this.findTokenById(tokenId);
    }
    if (this.isExpired(token)) {
      await this.refreshToken(token, true);
    }
    return this._refreshQuotaSync(token, tokenId);
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
    const groupThreshold = policy.modelGroupPercent / 100;
    const globalThreshold = policy.globalPercent / 100;

    const groupBlocked = modelGroupRemaining <= groupThreshold;
    let globalBlocked = false;
    let globalRemaining;
    if (policy.crossModelGlobalBlock === true) {
      const globalMin = quotaManager.getGlobalMinQuota(tokenId);
      globalRemaining = globalMin.hasData ? globalMin.remaining : 1;
      globalBlocked = globalRemaining <= globalThreshold;
    }

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
    const policy = this.thresholdPolicy;
    const thresholdResult = await this._evaluateThreshold(token, modelId);
    if (thresholdResult.pass) return true;

    if (policy.allBelowThresholdAction === 'fail_open') {
      fallbackCandidates.push(tokenIndex);
    }
    return false;
  }

  _shouldApplyThresholdForToken(token, bypassThreshold) {
    const tokenPolicy = normalizeTokenThresholdControl(token);
    if (tokenPolicy.useThreshold !== true) {
      return false;
    }

    // 双重允许才绕过：请求是特殊 key 且凭证允许绕过
    if (bypassThreshold === true && tokenPolicy.allowBypassWithSpecialKey === true) {
      return false;
    }

    return true;
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
        if (result !== 'ready') {
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
   * 获取所有 token 中指定模型组的最早额度恢复时间
   * @param {string} modelId - 模型 ID
   * @returns {number|null} 最早恢复时间戳（毫秒），无数据返回 null
   * @private
   */
  _getEarliestResetTimeAcrossTokens(modelId) {
    if (!modelId) return null;
    let earliestReset = null;

    for (const token of this.tokens) {
      try {
        const salt = this.store._salt;
        if (!salt) continue;
        const tokenId = generateTokenId(token.refresh_token, salt);
        const { resetTime } = quotaManager.getModelGroupResetTime(tokenId, modelId);
        if (resetTime !== null) {
          if (earliestReset === null || resetTime < earliestReset) {
            earliestReset = resetTime;
          }
        }
      } catch {
        // ignore
      }
    }
    return earliestReset;
  }

  /**
   * 格式化恢复时间为 HH:MM（北京时间），加上配置的偏移量
   * @param {number|null} resetTimeMs - 恢复时间戳（毫秒）
   * @returns {string} 格式化的时间或 '未知'
   * @private
   */
  _formatResetTime(resetTimeMs) {
    if (!resetTimeMs) return '未知';
    const offsetMinutes = config.tokenMessages?.resetTimeOffsetMinutes ?? 15;
    const adjustedTime = new Date(resetTimeMs + offsetMinutes * 60 * 1000);
    try {
      return adjustedTime.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai'
      });
    } catch {
      return '未知';
    }
  }

  /**
   * 构造并抛出 TokenError，根据 reason 从配置中读取消息模板并替换占位符
   * @param {string} reason - 不可用原因代码
   * @param {string|null} modelId - 模型 ID
   * @throws {TokenError}
   * @private
   */
  _throwTokenUnavailable(reason, modelId = null) {
    const messages = config.tokenMessages || {};
    let template = messages[reason] || reason;

    // 替换 {model} 占位符
    if (modelId) {
      template = template.replace(/\{model\}/g, modelId);
    } else {
      template = template.replace(/\{model\}/g, '未知模型');
    }

    // 替换 {reset_time} 占位符
    if (template.includes('{reset_time}')) {
      const resetTimeMs = this._getEarliestResetTimeAcrossTokens(modelId);
      const formatted = this._formatResetTime(resetTimeMs);
      template = template.replace(/\{reset_time\}/g, formatted);
    }

    log.warn(`[GeminiCLI] 凭证不可用 (reason=${reason}, model=${modelId || 'N/A'}): ${template}`);
    throw new TokenError(template, null, 503, reason);
  }

  /**
   * 获取可用的 token
   * @param {string|null} modelId - 请求模型ID（用于阈值判断）
   * @param {Object} [options]
   * @param {boolean} [options.bypassThreshold=false] - 是否跳过阈值过滤
   * @returns {Promise<Object>} token 对象
   * @throws {TokenError} 无可用 token 时抛出带自定义消息的错误
   */
  async getToken(modelId = null, options = {}) {
    await this._ensureInitialized();
    if (this.tokens.length === 0) {
      if (this._totalTokenCount > 0) {
        this._throwTokenUnavailable('all_disabled', modelId);
      } else {
        this._throwTokenUnavailable('pool_empty', modelId);
      }
    }

    if (this.rotationStrategy === RotationStrategy.QUOTA_EXHAUSTED) {
      return this._getTokenForQuotaExhaustedStrategy(modelId, options);
    }

    return this._getTokenForDefaultStrategy(modelId, options);
  }

  async _getTokenForQuotaExhaustedStrategy(modelId = null, options = {}) {
    if (this.availableQuotaTokenIndices.length === 0) {
      this._resetAllQuotas();
    }

    const totalAvailable = this.availableQuotaTokenIndices.length;
    if (totalAvailable === 0) {
      this._throwTokenUnavailable('quota_exhausted', modelId);
    }

    let allTokensExhausted = false;
    if (modelId) {
      allTokensExhausted = this._checkAllTokensExhaustedForModel(modelId);
    }
    const applyThresholdForStrategy = modelId &&
      this._shouldApplyThresholdForStrategy(RotationStrategy.QUOTA_EXHAUSTED);
    const fallbackCandidates = [];
    let thresholdCheckedCount = 0;
    let thresholdFilteredCount = 0;

    const startIndex = this.currentQuotaIndex % totalAvailable;
    const excludeTokenIds = new Set(options.excludeTokenIds || []);
    const candidateIndices = [];

    for (let i = 0; i < totalAvailable; i++) {
      const listIndex = (startIndex + i) % totalAvailable;
      const tokenIndex = this.availableQuotaTokenIndices[listIndex];
      const token = this.tokens[tokenIndex];
      if (!token) continue;
      const tokenId = this.getTokenId(token);
      if (tokenId && excludeTokenIds.has(tokenId)) continue;
      candidateIndices.push(tokenIndex);
    }

    const orderedIndices = this._buildOrderedCandidateIndices(candidateIndices, modelId);

    for (const tokenIndex of orderedIndices) {
      const listIndex = this.availableQuotaTokenIndices.indexOf(tokenIndex);
      const token = this.tokens[tokenIndex];
      if (!token) continue;

      if (modelId && !allTokensExhausted) {
        if (!this._canUseTokenForModel(token, modelId)) {
          continue;
        }
      }

      const applyThreshold = applyThresholdForStrategy &&
        this._shouldApplyThresholdForToken(token, options.bypassThreshold === true);

      if (applyThreshold) {
        thresholdCheckedCount++;
        const pass = await this._checkThresholdAndCollectFallback(token, modelId, fallbackCandidates, tokenIndex);
        if (!pass) {
          thresholdFilteredCount++;
          continue;
        }
      }

      try {
        const result = await this._prepareToken(token);
        if (result === 'disable') {
          this.disableToken(token);
          this._rebuildAvailableQuotaTokens();
          if (this.tokens.length === 0 || this.availableQuotaTokenIndices.length === 0) {
            this._throwTokenUnavailable('all_disabled', modelId);
          }
          continue;
        }
        if (result !== 'ready') {
          continue;
        }

        this.currentIndex = tokenIndex;
        this.currentQuotaIndex = listIndex;
        return token;
      } catch (error) {
        if (error.name === 'TokenError') throw error;
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
          this._rebuildAvailableQuotaTokens();
          if (this.tokens.length === 0 || this.availableQuotaTokenIndices.length === 0) {
            this._throwTokenUnavailable('all_disabled', modelId);
          }
        }
      }
    }

    const allBelowThreshold = thresholdCheckedCount > 0 && thresholdFilteredCount === thresholdCheckedCount;
    if (applyThresholdForStrategy && allBelowThreshold) {
      if (this.thresholdPolicy.allBelowThresholdAction === 'fail_open') {
        log.warn(`[GeminiCLI] 阈值策略触发保底放行: 模型 ${modelId} 所有候选凭证均低于阈值，尝试保底选取`);
        const fallbackToken = await this._tryGetFallbackToken(fallbackCandidates, RotationStrategy.QUOTA_EXHAUSTED);
        if (fallbackToken) {
          const pos = this.availableQuotaTokenIndices.indexOf(this.currentIndex);
          if (pos !== -1) this.currentQuotaIndex = pos;
          return fallbackToken;
        }
      } else {
        log.warn(`[GeminiCLI] 阈值策略严格模式生效: 模型 ${modelId} 所有候选凭证均低于阈值，返回无可用凭证`);
        this._throwTokenUnavailable('threshold_strict', modelId);
      }
    }

    this._resetAllQuotas();
    if (!this.tokens[0]) this._throwTokenUnavailable('no_available', modelId);
    return this.tokens[0];
  }

  async _getTokenForDefaultStrategy(modelId = null, options = {}) {
    const totalTokens = this.tokens.length;
    const startIndex = this.currentIndex;
    const excludeTokenIds = new Set(options.excludeTokenIds || []);

    let allTokensExhausted = false;
    if (modelId) {
      allTokensExhausted = this._checkAllTokensExhaustedForModel(modelId);
    }
    const applyThresholdForStrategy = modelId &&
      this._shouldApplyThresholdForStrategy(this.rotationStrategy);
    const fallbackCandidates = [];
    let thresholdCheckedCount = 0;
    let thresholdFilteredCount = 0;
    const candidateIndices = [];

    for (let i = 0; i < totalTokens; i++) {
      const index = (startIndex + i) % totalTokens;
      const token = this.tokens[index];
      if (!token) continue;
      const tokenId = this.getTokenId(token);
      if (tokenId && excludeTokenIds.has(tokenId)) continue;
      candidateIndices.push(index);
    }

    const orderedIndices = this._buildOrderedCandidateIndices(candidateIndices, modelId);

    for (const index of orderedIndices) {
      const token = this.tokens[index];
      if (!token) continue;

      if (modelId && !allTokensExhausted) {
        if (!this._canUseTokenForModel(token, modelId)) {
          continue;
        }
      }

      const applyThreshold = applyThresholdForStrategy &&
        this._shouldApplyThresholdForToken(token, options.bypassThreshold === true);

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
          if (this.tokens.length === 0) this._throwTokenUnavailable('all_disabled', modelId);
          continue;
        }
        if (result !== 'ready') {
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
        if (error.name === 'TokenError') throw error;
        const action = this._handleTokenError(error, token);
        if (action === 'disable') {
          this.disableToken(token);
          if (this.tokens.length === 0) this._throwTokenUnavailable('all_disabled', modelId);
        }
        // skip: 继续尝试下一个 token
      }
    }

    const allBelowThreshold = thresholdCheckedCount > 0 && thresholdFilteredCount === thresholdCheckedCount;
    if (applyThresholdForStrategy && allBelowThreshold) {
      if (this.thresholdPolicy.allBelowThresholdAction === 'fail_open') {
        log.warn(`[GeminiCLI] 阈值策略触发保底放行: 模型 ${modelId} 所有候选凭证均低于阈值，尝试保底选取`);
        const fbToken = await this._tryGetFallbackToken(fallbackCandidates, this.rotationStrategy);
        if (fbToken) return fbToken;
        this._throwTokenUnavailable('threshold_strict', modelId);
      }
      log.warn(`[GeminiCLI] 阈值策略严格模式生效: 模型 ${modelId} 所有候选凭证均低于阈值，返回无可用凭证`);
      this._throwTokenUnavailable('threshold_strict', modelId);
    }

    this._throwTokenUnavailable('model_exhausted', modelId);
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

  async markPreviewCapability(token, capability) {
    if (!token?.refresh_token) return;
    token.previewCapability = normalizePreviewCapability(capability, GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN);
    await this._persistTokenRecord(token);
  }

  async markPreviewUnsupported(token, modelId = null) {
    await this.markPreviewCapability(token, GEMINICLI_PREVIEW_CAPABILITY.UNSUPPORTED);
    const tokenId = this.getTokenId(token);
    log.warn(`[GeminiCLI] Token ${tokenId || 'unknown'} 已标记为不支持 preview${modelId ? ` (${modelId})` : ''}`);
  }

  async _upsertTokenRecord(tokenRecord, { reload = true } = {}) {
    const allTokens = await this.store.readAll();
    const existingIndex = allTokens.findIndex((token) => token.refresh_token === tokenRecord.refresh_token);
    const operation = existingIndex === -1 ? 'added' : 'updated';

    if (existingIndex === -1) {
      allTokens.push(tokenRecord);
    } else {
      allTokens[existingIndex] = { ...allTokens[existingIndex], ...tokenRecord };
    }

    await this.store.writeAll(allTokens);
    if (reload) {
      await this.reload();
    }

    const salt = await this.store.getSalt();
    const tokenId = generateTokenId(tokenRecord.refresh_token, salt);
    return { operation, tokenId };
  }

  _buildTokenRecord(normalized, existingToken = null) {
    const base = existingToken ? this._normalizeStoredToken(existingToken) : null;
    const explicitProjectId = normalized.projectId || base?.projectId || null;
    const inferredStatus = deriveStoredStatus({
      ...base,
      ...normalized,
      projectId: explicitProjectId
    });

    return {
      ...(base || {}),
      access_token: normalized.access_token ?? base?.access_token ?? '',
      refresh_token: normalized.refresh_token ?? base?.refresh_token ?? '',
      expires_in: normalized.expires_in ?? base?.expires_in ?? 3599,
      timestamp: normalized.timestamp ?? base?.timestamp ?? Date.now(),
      enable: normalized.enable !== undefined ? normalized.enable : (base?.enable !== false),
      email: normalized.email ?? base?.email ?? null,
      projectId: explicitProjectId,
      hasQuota: normalized.hasQuota !== undefined ? normalized.hasQuota : (base?.hasQuota !== false),
      useThreshold: normalized.useThreshold !== undefined ? normalized.useThreshold : (base?.useThreshold ?? DEFAULT_TOKEN_THRESHOLD_CONTROL.useThreshold),
      allowBypassWithSpecialKey: normalized.allowBypassWithSpecialKey !== undefined
        ? normalized.allowBypassWithSpecialKey
        : (base?.allowBypassWithSpecialKey ?? DEFAULT_TOKEN_THRESHOLD_CONTROL.allowBypassWithSpecialKey),
      tier: normalizeTier(normalized.tier, base?.tier || 'pro'),
      status: normalizeStatus(normalized.status, inferredStatus),
      pendingStage: normalizePendingStageValue(
        normalized.pendingStage,
        inferredStatus === GEMINICLI_TOKEN_STATUS.PENDING
          ? (explicitProjectId ? GEMINICLI_PENDING_STAGE.ENABLE_APIS : GEMINICLI_PENDING_STAGE.PROJECT_ID)
          : null
      ),
      lastError: normalized.lastError !== undefined
        ? normalizeTokenErrorMessage(normalized.lastError)
        : normalizeTokenErrorMessage(base?.lastError),
      lastAttemptAt: normalized.lastAttemptAt !== undefined
        ? normalizeLastAttemptAt(normalized.lastAttemptAt)
        : normalizeLastAttemptAt(base?.lastAttemptAt),
      repairCount: normalized.repairCount !== undefined
        ? normalizeRepairCount(normalized.repairCount)
        : normalizeRepairCount(base?.repairCount),
      previewCapability: normalizePreviewCapability(
        normalized.previewCapability ?? normalized.preview,
        base?.previewCapability || GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN
      )
    };
  }

  /**
   * 将 gcli2api 格式的凭证数据转换为 Node.js 项目格式
   * 自动处理字段名映射和过期时间格式差异
   * @param {Object} data - 原始凭证数据（可能来自 gcli2api 或本项目）
   * @returns {Object} 格式化后的凭证数据
   */
  static normalizeCredentialFormat(data) {
    const result = { ...data };

    if (result.token && !result.access_token) {
      result.access_token = result.token;
    }
    delete result.token;

    if (result.accessToken && !result.access_token) {
      result.access_token = result.accessToken;
    }
    delete result.accessToken;

    if (result.refreshToken && !result.refresh_token) {
      result.refresh_token = result.refreshToken;
    }
    delete result.refreshToken;

    // 1. project_id → projectId（gcli2api 用下划线格式）
    if (result.project_id && !result.projectId) {
      result.projectId = result.project_id;
    }
    if (result.project && !result.projectId) {
      result.projectId = result.project;
    }
    delete result.project_id;
    delete result.project;

    if (result.user_email && !result.email) {
      result.email = result.user_email;
    }
    delete result.user_email;

    if (result.enabled !== undefined && result.enable === undefined) {
      result.enable = normalizeBooleanLike(result.enabled);
    }
    if (result.disabled !== undefined && result.enable === undefined) {
      const disabledValue = normalizeBooleanLike(result.disabled);
      if (disabledValue !== undefined) {
        result.enable = !disabledValue;
      }
    }
    delete result.enabled;
    delete result.disabled;

    // 2. expiry / expires_at (ISO datetime) → expires_in + timestamp
    const expiryValue = result.expiry || result.expires_at;
    if (expiryValue && (result.expires_in === undefined || result.expires_in === null || result.expires_in === "")) {
      const expiresAtMs = new Date(expiryValue).getTime();
      if (!isNaN(expiresAtMs)) {
        result.timestamp = result.timestamp || Date.now();
        result.expires_in = Math.max(0, Math.floor((expiresAtMs - result.timestamp) / 1000));
      }
    }
    delete result.expiry;
    delete result.expires_at;

    // 3. 清理 gcli2api 特有的字段（Node.js 使用全局 GEMINICLI_OAUTH_CONFIG）
    delete result.client_id;
    delete result.client_secret;

    // 4. 确保必需字段有默认值
    if (result.enable === undefined) result.enable = true;

    // 5. tier 兼容（gcli2api 可能导出 tier 字段）
    if (result.tier) {
      result.tier = result.tier.toLowerCase();
    }

    if (result.preview !== undefined && result.previewCapability === undefined) {
      result.previewCapability = normalizePreviewCapability(result.preview);
    }
    delete result.preview;

    return result;
  }

  async addToken(tokenData, options = {}) {
    try {
      const { reload = true, attemptRepair = true, source = 'manual' } = options;
      const normalized = GeminiCliTokenManager.normalizeCredentialFormat(tokenData);
      if ((source === 'oauth' || source === 'geminicli') && normalized.enable === undefined) {
        normalized.enable = true;
      }
      if (!normalized.refresh_token) {
        return { success: false, message: 'refresh_token必填' };
      }
      if (!normalized.access_token) {
        return { success: false, message: 'access_token/token必填' };
      }

      const allTokens = await this.store.readAll();
      const existingToken = allTokens.find((token) => token.refresh_token === normalized.refresh_token) || null;
      const tokenRecord = this._buildTokenRecord(normalized, existingToken);

      if (source === 'oauth' && !tokenRecord.projectId) {
        this._applyLifecycleState(tokenRecord, {
          status: GEMINICLI_TOKEN_STATUS.PENDING,
          pendingStage: GEMINICLI_PENDING_STAGE.OAUTH_EXCHANGED,
          lastError: null
        });
      }

      if (attemptRepair && tokenRecord.enable !== false && tokenRecord.status !== GEMINICLI_TOKEN_STATUS.INVALID) {
        await this._repairTokenLifecycle(tokenRecord, {
          trigger: source,
          incrementRepairCount: true
        });
      }

      const { operation, tokenId } = await this._upsertTokenRecord(tokenRecord, { reload });

      const isReady = tokenRecord.status === GEMINICLI_TOKEN_STATUS.READY;
      const actionMessage = operation === 'added' ? 'Token添加成功' : 'Token更新成功';
      const finalMessage = isReady ? actionMessage : `${actionMessage}（当前处于待修复状态）`;

      return {
        success: true,
        message: finalMessage,
        data: {
          id: tokenId,
          operation,
          status: tokenRecord.status,
          pendingStage: tokenRecord.pendingStage || null,
          projectId: tokenRecord.projectId || null,
          tier: tokenRecord.tier || 'pro',
          previewCapability: tokenRecord.previewCapability || GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN,
          lastError: tokenRecord.lastError || null,
          lastAttemptAt: tokenRecord.lastAttemptAt || null,
          repairCount: tokenRecord.repairCount || 0
        }
      };
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

      return allTokens.map(token => {
        const normalizedToken = this._normalizeStoredToken(token);
        const tokenId = generateTokenId(normalizedToken.refresh_token, salt);
        const quotaData = quotaManager.getQuotaAnyAge(tokenId);

        // 构造额度摘要：按模型组聚合
        let quotaSummary = null;
        if (quotaData && quotaData.models) {
          const groups = {};
          for (const [modelId, mQuota] of Object.entries(quotaData.models)) {
            const group = getGroupKey(modelId);
            if (!groups[group]) {
              groups[group] = { remaining: mQuota.r ?? 1, resetTime: mQuota.t || null };
            } else {
              if ((mQuota.r ?? 1) < groups[group].remaining) {
                groups[group].remaining = mQuota.r ?? 1;
              }
              if (mQuota.t && (!groups[group].resetTime || mQuota.t < groups[group].resetTime)) {
                groups[group].resetTime = mQuota.t;
              }
            }
          }
          quotaSummary = {
            groups,
            lastUpdated: quotaData.lastUpdated || null,
            requestCounts: quotaData.requestCounts || {}
          };
        }

        return {
          ...normalizeTokenThresholdControl(normalizedToken),
          id: tokenId,
          expires_in: normalizedToken.expires_in,
          timestamp: normalizedToken.timestamp,
          enable: normalizedToken.enable !== false,
          email: normalizedToken.email || null,
          projectId: normalizedToken.projectId || null,
          tier: normalizedToken.tier || 'pro',
          status: normalizedToken.status || GEMINICLI_TOKEN_STATUS.PENDING,
          pendingStage: normalizedToken.pendingStage || null,
          lastError: normalizedToken.lastError || null,
          lastAttemptAt: normalizedToken.lastAttemptAt || null,
          repairCount: normalizedToken.repairCount || 0,
          previewCapability: normalizedToken.previewCapability || GEMINICLI_PREVIEW_CAPABILITY.UNKNOWN,
          quota: quotaSummary,
          cooldowns: tokenCooldownManager.getAllCooldowns()[tokenId] || null
        };
      });
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
    return this.repairTokenById(tokenId, 'manual_project_id');
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
      timestamp: refreshedToken.timestamp,
      status: refreshedToken.status || GEMINICLI_TOKEN_STATUS.PENDING
    };
  }

  /**
   * 获取盐值
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    return this.store.getSalt();
  }

  /**
   * 根据 token 对象获取 tokenId
   * @param {Object} token - Token 对象
   * @returns {string|null} tokenId，如果无法生成返回 null
   */
  getTokenId(token) {
    if (!token?.refresh_token) return null;
    try {
      const salt = this.store._salt;
      if (!salt) return null;
      return generateTokenId(token.refresh_token, salt);
    } catch {
      return null;
    }
  }

  // 获取当前轮询配置
  getRotationConfig() {
    return {
      strategy: this.rotationStrategy,
      requestCount: this.requestCountPerToken,
      thresholdPolicy: cloneThresholdPolicy(this.thresholdPolicy),
      currentIndex: this.currentIndex,
      currentQuotaIndex: this.currentQuotaIndex,
      tokenCounts: Object.fromEntries(this.tokenRequestCounts)
    };
  }
}

// 导出策略枚举
export { RotationStrategy };

const geminicliTokenManager = new GeminiCliTokenManager();
export default geminicliTokenManager;

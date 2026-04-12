import crypto from 'crypto';
import log from '../utils/logger.js';
import requesterManager from '../utils/requesterManager.js';
import ProjectIdFetcher from './project_id_fetcher.js';
import {
  AUTH_MODES,
  GEMINICLI_OAUTH_CONFIG,
  GEMINICLI_OAUTH_SCOPES,
  OAUTH_CONFIG,
  OAUTH_SCOPES,
} from '../constants/oauth.js';

class OAuthManager {
  constructor() {
    this.state = crypto.randomUUID();
  }

  normalizeMode(mode) {
    const normalized = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    return normalized === AUTH_MODES.GEMINICLI
      ? AUTH_MODES.GEMINICLI
      : AUTH_MODES.ANTIGRAVITY;
  }

  /**
   * 生成授权URL
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  generateAuthUrl(port, mode = AUTH_MODES.ANTIGRAVITY, stateOverride = null) {
    const normalizedMode = this.normalizeMode(mode);
    const oauthConfig =
      normalizedMode === AUTH_MODES.GEMINICLI ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;
    const scopes = normalizedMode === AUTH_MODES.GEMINICLI ? GEMINICLI_OAUTH_SCOPES : OAUTH_SCOPES;

    const params = new URLSearchParams({
      access_type: 'offline',
      client_id: oauthConfig.CLIENT_ID,
      prompt: 'consent',
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      response_type: 'code',
      scope: scopes.join(' '),
      state: stateOverride || `${this.state}_${normalizedMode}`,
    });
    return `${oauthConfig.AUTH_URL}?${params.toString()}`;
  }

  /**
   * 交换授权码获取Token
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  async exchangeCodeForToken(code, port, mode = AUTH_MODES.ANTIGRAVITY) {
    const normalizedMode = this.normalizeMode(mode);
    const oauthConfig =
      normalizedMode === AUTH_MODES.GEMINICLI ? GEMINICLI_OAUTH_CONFIG : OAUTH_CONFIG;

    const postData = new URLSearchParams({
      code,
      client_id: oauthConfig.CLIENT_ID,
      client_secret: oauthConfig.CLIENT_SECRET,
      redirect_uri: `http://localhost:${port}/oauth-callback`,
      grant_type: 'authorization_code',
    });

    const headers = {
      Host: 'oauth2.googleapis.com',
      'User-Agent': 'Go-http-client/1.1',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept-Encoding': 'gzip',
    };

    try {
      const { data } = await requesterManager.fetch(oauthConfig.TOKEN_URL, {
        method: 'POST',
        headers,
        body: postData.toString(),
      });
      return data;
    } catch (error) {
      throw new Error(`Token交换请求失败 (${error.status ?? ''}): ${error.message}`);
    }
  }

  /**
   * 获取用户邮箱
   */
  async fetchUserEmail(accessToken) {
    const headers = {
      Host: 'www.googleapis.com',
      'User-Agent': 'Go-http-client/1.1',
      Authorization: `Bearer ${accessToken}`,
      'Accept-Encoding': 'gzip',
    };

    try {
      const { data } = await requesterManager.fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          method: 'GET',
          headers,
        },
      );
      return data?.email;
    } catch (err) {
      log.warn('获取用户邮箱失败:', err.message);
      return null;
    }
  }

  /**
   * 使用 ProjectIdFetcher 的完整验证流程获取账号信息
   */
  async validateAccount(accessToken) {
    const fetcher = new ProjectIdFetcher();
    return fetcher.validateAccount({ access_token: accessToken });
  }

  /**
   * 完整的OAuth认证流程：交换Token -> 获取邮箱 -> 资格校验
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   * @param {string} mode - 模式：'antigravity' 或 'geminicli'
   */
  async authenticate(code, port, mode = AUTH_MODES.ANTIGRAVITY) {
    const normalizedMode = this.normalizeMode(mode);
    const tokenData = await this.exchangeCodeForToken(code, port, normalizedMode);

    if (!tokenData.access_token) {
      throw new Error('Token交换失败：未获取到access_token');
    }

    const account = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_in: tokenData.expires_in,
      timestamp: Date.now(),
    };

    const email = await this.fetchUserEmail(account.access_token);
    if (email) {
      account.email = email;
      log.info(`[${normalizedMode}] 获取到用户邮箱: ${email}`);
    }

    if (normalizedMode === AUTH_MODES.ANTIGRAVITY) {
      const validation = await this.validateAccount(account.access_token);
      account.projectId = validation.projectId;
      account.hasQuota = validation.hasQuota;
      account.sub = validation.sub;
      account.isActivated = validation.isActivated;

      if (validation.credits !== null && validation.credits !== undefined) {
        account.credits = validation.credits;
        log.info(
          `[${normalizedMode}] 账号验证完成: sub=${validation.sub}, source=${validation.source}, credits=${validation.credits}`,
        );
      } else {
        log.info(
          `[${normalizedMode}] 账号验证完成: sub=${validation.sub}, source=${validation.source}`,
        );
      }
    }

    account.enable = true;
    return account;
  }

  /**
   * Gemini CLI 专用认证流程（简化版，不需要 projectId）
   * @param {string} code - 授权码
   * @param {number} port - 回调端口
   */
  async authenticateGeminiCli(code, port) {
    return this.authenticate(code, port, AUTH_MODES.GEMINICLI);
  }
}

export default new OAuthManager();

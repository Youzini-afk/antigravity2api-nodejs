/**
 * 客户端限制中间件
 * 阻止代码工具（Cursor、OpenClaw 等）调用 API
 * 支持 UA 黑名单、禁用工具调用、System prompt 黑名单
 */

import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * 构建拒绝响应（兼容 OpenAI 错误格式）
 */
function buildRejectResponse(message, statusCode = 403) {
  return {
    error: {
      message,
      type: 'client_restricted',
      code: 'client_restricted',
      param: null
    }
  };
}

/**
 * 客户端限制中间件
 */
export function clientRestrictionMiddleware(req, res, next) {
  // 白名单 key 直接放行
  if (req.apiAuthContext?.isUnrestricted === true) {
    return next();
  }

  const restriction = config.clientRestriction;
  if (!restriction?.enabled) {
    return next();
  }

  // 1. UA 黑名单检查
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (ua && restriction.uaBlacklist.length > 0) {
    for (const keyword of restriction.uaBlacklist) {
      if (ua.includes(keyword)) {
        const msg = restriction.messages?.uaBlocked || '检测到不支持的客户端';
        logger.warn(`[ClientRestriction] UA 黑名单命中: "${keyword}" (UA: ${ua.substring(0, 100)})`);
        return res.status(403).json(buildRejectResponse(msg));
      }
    }
  }

  // 以下检查需要 body，仅对有 body 的请求生效
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return next();
  }

  // 2. 工具调用检查
  if (restriction.blockToolCalls) {
    const hasTools = body.tools || body.functions || body.tool_choice || body.function_call;
    if (hasTools) {
      if (restriction.toolCallAction === 'reject') {
        const msg = restriction.messages?.toolCallBlocked || '当前接口不支持工具调用';
        logger.warn(`[ClientRestriction] 工具调用被拒绝`);
        return res.status(403).json(buildRejectResponse(msg));
      }
      // strip 模式：静默剥离
      delete body.tools;
      delete body.functions;
      delete body.tool_choice;
      delete body.function_call;
      logger.info(`[ClientRestriction] 已剥离工具调用字段`);
    }
  }

  // 3. System prompt 黑名单检查
  if (restriction.systemPromptBlacklist.length > 0 && Array.isArray(body.messages)) {
    const systemMessages = body.messages.filter(m => m.role === 'system');
    for (const sysMsg of systemMessages) {
      const content = typeof sysMsg.content === 'string' ? sysMsg.content : '';
      const contentLower = content.toLowerCase();
      for (const keyword of restriction.systemPromptBlacklist) {
        if (contentLower.includes(keyword.toLowerCase())) {
          const msg = restriction.messages?.systemPromptBlocked || '检测到不允许的系统提示词';
          logger.warn(`[ClientRestriction] System prompt 黑名单命中: "${keyword}"`);
          return res.status(403).json(buildRejectResponse(msg));
        }
      }
    }
  }

  next();
}

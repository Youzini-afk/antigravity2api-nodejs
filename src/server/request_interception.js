/**
 * 请求拦截中间件
 * 检测测试消息、参数不合规、结构违规，转发到外部模型或自动修正
 */

import config from '../config/config.js';
import logger from '../utils/logger.js';
import { proxyToExternal } from './external_proxy.js';

/**
 * 简单 glob 匹配（支持 * 通配符）
 */
function globMatch(pattern, str) {
  // 先转义所有正则特殊字符，再将 glob 的 \* 和 \? 还原为正则通配符
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return regex.test(str);
}

/**
 * 获取最后一条指定角色的消息内容
 */
function getLastMessageContent(messages, role) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === role) {
      return typeof messages[i].content === 'string' ? messages[i].content : null;
    }
  }
  return null;
}

/**
 * 检测是否为测试/简短消息
 */
function isTestMessage(messages, testConfig) {
  if (!testConfig?.enabled) return false;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  // 只看最后一条 user 消息
  const lastUserMsg = getLastMessageContent(messages, 'user');
  if (lastUserMsg === null) return false;

  const trimmed = lastUserMsg.trim();
  if (!trimmed) return true; // 空消息视为测试

  // 长度检测
  if (trimmed.length <= (testConfig.maxLength || 20)) {
    return true;
  }

  // 关键词检测
  if (Array.isArray(testConfig.keywords) && testConfig.keywords.length > 0) {
    const lower = trimmed.toLowerCase();
    for (const keyword of testConfig.keywords) {
      if (lower === keyword || lower.includes(keyword)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 请求拦截中间件
 */
export async function requestInterceptionMiddleware(req, res, next) {
  const interception = config.requestInterception;
  if (!interception?.enabled) {
    return next();
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return next();
  }

  // 只处理 chat completions 类的请求（有 messages 的）
  if (!Array.isArray(body.messages)) {
    return next();
  }

  const model = body.model || '';
  const stream = body.stream === true;

  try {
    // 1. 测试消息检测
    if (isTestMessage(body.messages, interception.testMessage)) {
      logger.info(`[RequestInterception] 测试消息拦截 → 转发外部模型`);
      return await proxyToExternal({ body, stream, res, reason: 'test_message' });
    }

    // 2. 模型规则匹配
    if (model && Array.isArray(interception.modelRules) && interception.modelRules.length > 0) {
      for (const rule of interception.modelRules) {
        if (!globMatch(rule.pattern, model)) continue;

        // 2a. 自动修正参数
        if (rule.maxTemperature !== null && typeof body.temperature === 'number' && body.temperature > rule.maxTemperature) {
          logger.info(`[RequestInterception] 模型 ${model}: 温度 ${body.temperature} → ${rule.maxTemperature}`);
          body.temperature = rule.maxTemperature;
        }
        if (rule.maxTokens !== null && typeof body.max_tokens === 'number' && body.max_tokens > rule.maxTokens) {
          logger.info(`[RequestInterception] 模型 ${model}: max_tokens ${body.max_tokens} → ${rule.maxTokens}`);
          body.max_tokens = rule.maxTokens;
        }

        // 2b. 结构违规检测 → 转发外部
        if (rule.noPrefill) {
          const lastMsg = body.messages[body.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant') {
            logger.info(`[RequestInterception] 模型 ${model}: 检测到预填充 → 转发外部模型`);
            return await proxyToExternal({ body, stream, res, reason: 'prefill_detected' });
          }
        }
        if (rule.requireUserLast) {
          const lastMsg = body.messages[body.messages.length - 1];
          if (lastMsg && lastMsg.role !== 'user') {
            logger.info(`[RequestInterception] 模型 ${model}: 最后消息非 user (${lastMsg.role}) → 转发外部模型`);
            return await proxyToExternal({ body, stream, res, reason: 'user_last_required' });
          }
        }

        // 只匹配第一条规则
        break;
      }
    }

    next();
  } catch (error) {
    logger.error(`[RequestInterception] 中间件异常: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({
        error: { message: '请求拦截处理失败', type: 'server_error', code: 'interception_error' }
      });
    }
  }
}

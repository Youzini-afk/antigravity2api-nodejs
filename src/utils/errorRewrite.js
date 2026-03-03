import config from '../config/config.js';
import logger from './logger.js';

const VALID_SCOPES = new Set(['openai', 'gemini', 'claude']);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toStringSafe(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function getRawText(error) {
  if (!error) return '';

  if (error.rawBody !== undefined && error.rawBody !== null) {
    if (typeof error.rawBody === 'string') return error.rawBody;
    try {
      return JSON.stringify(error.rawBody);
    } catch {
      return String(error.rawBody);
    }
  }

  const responseData = error?.response?.data;
  if (responseData !== undefined && responseData !== null) {
    if (typeof responseData === 'string') return responseData;
    try {
      return JSON.stringify(responseData);
    } catch {
      return String(responseData);
    }
  }

  return '';
}

function isRuleScopeMatched(ruleScope, currentScope) {
  if (!currentScope || !VALID_SCOPES.has(currentScope)) return false;
  const scopes = toArray(ruleScope);
  if (scopes.length === 0) return true;
  return scopes.includes(currentScope);
}

function hasValues(arr) {
  return Array.isArray(arr) && arr.length > 0;
}

function matchExact(arr, value) {
  if (!hasValues(arr)) return null;
  return arr.includes(value);
}

function matchContains(arr, value) {
  if (!hasValues(arr)) return null;
  return arr.some(item => value.includes(item));
}

function matchStatusCodes(arr, status) {
  if (!hasValues(arr)) return null;
  return arr.includes(status);
}

function evaluateRuleMatch(rule, context) {
  const logic = rule.logic === 'or' ? 'or' : 'and';
  const match = rule.match || {};
  const status = Number(context.statusCode);
  const statusValue = Number.isFinite(status) ? status : -1;
  const typeValue = toStringSafe(context.type);
  const codeValue = toStringSafe(context.code);
  const messageValue = toStringSafe(context.message);
  const rawTextValue = toStringSafe(context.rawText);

  const groups = [
    matchStatusCodes(match.statusCodes, statusValue),
    matchExact(match.typeExact, typeValue),
    matchExact(match.codeExact, codeValue),
    matchExact(match.messageExact, messageValue),
    matchContains(match.messageContains, messageValue),
    matchExact(match.rawExact, rawTextValue),
    matchContains(match.rawContains, rawTextValue)
  ].filter(result => result !== null);

  if (groups.length === 0) return false;
  if (logic === 'or') return groups.some(Boolean);
  return groups.every(Boolean);
}

function applyMessageRewrite(originalMessage, rewrite) {
  const customMessage = toStringSafe(rewrite?.message);
  const source = toStringSafe(originalMessage);
  const mode = rewrite?.mode || 'replace';

  if (mode === 'prepend') {
    return `${customMessage}${source}`;
  }
  if (mode === 'append') {
    return `${source}${customMessage}`;
  }
  return customMessage;
}

export function rewriteErrorPayloadMessage(payload, context = {}) {
  try {
    const policy = config.errorRewrite;
    if (!policy || policy.enabled !== true) return payload;

    const currentScope = context.scope;
    if (!currentScope || !VALID_SCOPES.has(currentScope)) return payload;

    const rules = Array.isArray(policy.rules) ? policy.rules : [];
    if (rules.length === 0) return payload;

    const sourceError = context.error || null;
    const rawText = getRawText(sourceError);
    const statusCode = Number(context.statusCode);
    const normalizedStatusCode = Number.isFinite(statusCode) ? statusCode : 500;
    const nextPayload = payload ? JSON.parse(JSON.stringify(payload)) : payload;
    if (!nextPayload) return payload;

    const currentMessage = toStringSafe(context.message);
    const currentType = toStringSafe(context.type);
    const currentCode = toStringSafe(context.code);

    for (const rule of rules) {
      if (!rule || rule.enabled !== true) continue;
      if (!isRuleScopeMatched(rule.scope, currentScope)) continue;

      const matched = evaluateRuleMatch(rule, {
        statusCode: normalizedStatusCode,
        type: currentType,
        code: currentCode,
        message: currentMessage,
        rawText
      });
      if (!matched) continue;

      const rewrittenMessage = applyMessageRewrite(currentMessage, rule.rewrite || {});
      const payloadType = context.payloadType;
      if (payloadType === 'gemini') {
        if (nextPayload.error && typeof nextPayload.error === 'object') {
          nextPayload.error.message = rewrittenMessage;
        }
      } else if (payloadType === 'claude') {
        if (nextPayload.error && typeof nextPayload.error === 'object') {
          nextPayload.error.message = rewrittenMessage;
        }
      } else {
        if (nextPayload.error && typeof nextPayload.error === 'object') {
          nextPayload.error.message = rewrittenMessage;
        }
      }

      logger.info(`[ErrorRewrite] 命中规则: ${rule.id || 'unknown'} (scope=${currentScope}, status=${normalizedStatusCode})`);
      return nextPayload;
    }

    return payload;
  } catch (error) {
    logger.warn(`[ErrorRewrite] 规则执行失败，降级返回原错误: ${error.message}`);
    return payload;
  }
}

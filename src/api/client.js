import { randomUUID } from 'crypto';
import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import logger from '../utils/logger.js';
import memoryManager from '../utils/memoryManager.js';
import requesterManager from '../utils/requesterManager.js';
import { httpRequest } from '../utils/httpClient.js';
import { generateTrajectorybody } from '../utils/trajectory.js';
import { buildRecordCodeAssistMetricsBody } from '../utils/recordCodeAssistMetrics.js';
import { createTelemetryBatch, serializeTelemetryBatch } from "../utils/createTelemetry.js"
import { createLog1, createLog2 } from "../utils/additionalLogs.js"
import { buildClientRegister, buildFrontEnd, buildClientFeatrueHeaders, buildClientRegisterHeaders, buildFrontEndHeaders } from "../utils/unleash.js"
import { MODEL_LIST_CACHE_TTL, QA_PAIRS } from '../constants/index.js';
import { createApiError } from '../utils/errors.js';
import { generateCheckpointBody } from '../utils/checkPoint.js';
import axios from 'axios';
import {
  convertToToolCall,
  registerStreamMemoryCleanup
} from './stream_parser.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import {
  isDebugDumpEnabled,
  createDumpId,
  createStreamCollector,
  collectStreamChunk,
  dumpFinalRequest,
  dumpStreamResponse,
  dumpFinalRawResponse
} from './debugDump.js';
import { getUpstreamStatus, readUpstreamErrorBody, isCallerDoesNotHavePermission } from './upstreamError.js';
import { createStreamLineProcessor } from './streamLineProcessor.js';
import { runSseStream, postJsonAndParse } from './geminiTransport.js';
import { parseGeminiCandidateParts, toOpenAIUsage } from './geminiResponseParser.js';

// ==================== Token 计时器管理 ====================
const tokenTimers = new Map(); // { tokenKey: { lastUsed: timestamp, intervalId: intervalId } }
const TOKEN_TIMEOUT = 3 * 60 * 1000; // 3分钟
const unleashControl = {
  enabled: config.unleashControl?.enabled !== false,
  callIntervalMs: Number.isFinite(config.unleashControl?.callIntervalMs) ? config.unleashControl.callIntervalMs : 60 * 1000,
  failureBackoffMs: Number.isFinite(config.unleashControl?.failureBackoffMs) ? config.unleashControl.failureBackoffMs : 5 * 60 * 1000,
  failureThreshold: Number.isFinite(config.unleashControl?.failureThreshold) ? config.unleashControl.failureThreshold : 3,
  fallbackToAxios: config.unleashControl?.fallbackToAxios !== false,
  endpoints: {
    register: config.unleashControl?.endpoints?.register !== false,
    feature: config.unleashControl?.endpoints?.feature !== false,
    frontend: config.unleashControl?.endpoints?.frontend !== false
  }
};
const BACKEND_CALL_INTERVAL = unleashControl.callIntervalMs;
const UNLEASH_FAILURE_BACKOFF = unleashControl.failureBackoffMs;
const UNLEASH_FAILURE_THRESHOLD = unleashControl.failureThreshold;
const checkPointList = new Set([]);

function getTokenKey(token) {
  return token.access_token;
}

function getTokenSuffix(token) {
  return token?.access_token ? token.access_token.slice(-8) : 'unknown';
}

function isTransientNetworkError(error) {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') return true;
  if (message.includes('eof')) return true;
  if (message.includes('socket hang up')) return true;
  if (message.includes('connection reset')) return true;
  if (message.includes('network error')) return true;
  if (message.includes('timeout')) return true;
  return false;
}

function formatError(error) {
  if (!error) return 'unknown error';
  const code = error.code ? `${error.code}: ` : '';
  return `${code}${error.message || String(error)}`;
}

function toUnleashError(label, error) {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? '';
    const responseData = error.response?.data;
    const message = typeof responseData === 'string'
      ? responseData
      : responseData
        ? JSON.stringify(responseData)
        : error.message;
    return new Error(`${label}请求失败 (${status}): ${message}`);
  }

  const status = error?.status ?? '';
  const message = error?.message || String(error);
  return new Error(`${label}请求失败 (${status}): ${message}`);
}

async function runTokenBackendCalls(token, timerData) {
  if (!unleashControl.enabled) {
    return;
  }

  const tasks = [];
  if (unleashControl.endpoints.register) tasks.push({ name: 'ClientRegister', fn: () => sendClientRegister(token) });
  if (unleashControl.endpoints.feature) tasks.push({ name: 'ClientFeature', fn: () => sendClientFeature(token) });
  if (unleashControl.endpoints.frontend) tasks.push({ name: 'FrontEnd', fn: () => sendFrontEnd(token) });

  if (tasks.length === 0) {
    return;
  }

  const now = Date.now();
  if (timerData.unleashBackoffUntil && now < timerData.unleashBackoffUntil) {
    return;
  }
  if (timerData.unleashInFlight) {
    return;
  }
  timerData.unleashInFlight = true;

  try {
    const results = await Promise.allSettled(tasks.map(task => task.fn()));

    const failures = results
      .map((result, index) => ({ result, index }))
      .filter(item => item.result.status === 'rejected')
      .map(item => ({
        name: tasks[item.index].name,
        error: item.result.reason
      }));

    if (failures.length === 0) {
      timerData.consecutiveUnleashFailures = 0;
      timerData.unleashBackoffUntil = 0;
      return;
    }

    timerData.consecutiveUnleashFailures = (timerData.consecutiveUnleashFailures || 0) + 1;
    const allTransient = failures.every(item => isTransientNetworkError(item.error));
    const brief = failures.map(item => `${item.name}=${formatError(item.error)}`).join(' | ');

    if (allTransient && timerData.consecutiveUnleashFailures >= UNLEASH_FAILURE_THRESHOLD) {
      timerData.unleashBackoffUntil = now + UNLEASH_FAILURE_BACKOFF;
      logger.warn(`[Unleash] token ...${getTokenSuffix(token)} 连续 ${timerData.consecutiveUnleashFailures} 次网络失败，暂停上报 ${Math.round(UNLEASH_FAILURE_BACKOFF / 60000)} 分钟。最近错误: ${brief}`);
      return;
    }

    logger.warn(`[Unleash] token ...${getTokenSuffix(token)} 周期上报失败(${failures.length}/${tasks.length}): ${brief}`);
  } finally {
    timerData.unleashInFlight = false;
  }
}

function startTokenTimer(token) {
  if (!unleashControl.enabled) {
    return;
  }
  if (!unleashControl.endpoints.register && !unleashControl.endpoints.feature && !unleashControl.endpoints.frontend) {
    return;
  }

  const key = getTokenKey(token);
  const now = Date.now();

  if (tokenTimers.has(key)) {
    tokenTimers.get(key).lastUsed = now;
    return;
  }

  const timerData = {
    lastUsed: now,
    intervalId: null,
    consecutiveUnleashFailures: 0,
    unleashBackoffUntil: 0,
    unleashInFlight: false
  };

  timerData.intervalId = setInterval(() => {
    void runTokenBackendCalls(token, timerData);
  }, BACKEND_CALL_INTERVAL);
  timerData.intervalId.unref?.();

  tokenTimers.set(key, timerData);
  void runTokenBackendCalls(token, timerData);
}

function checkTokenTimeout() {
  const now = Date.now();
  for (const [key, data] of tokenTimers.entries()) {
    if (now - data.lastUsed > TOKEN_TIMEOUT) {
      clearInterval(data.intervalId);
      tokenTimers.delete(key);
    }
  }
}

const tokenTimeoutChecker = setInterval(checkTokenTimeout, 30 * 1000); // 每30秒检查一次超时
tokenTimeoutChecker.unref?.();

// ==================== 模型列表缓存（智能管理） ====================
const getModelCacheTTL = () => {
  return config.cache?.modelListTTL || MODEL_LIST_CACHE_TTL;
};

let modelListCache = null;
let modelListCacheTime = 0;

// 默认模型列表（当 API 请求失败时使用）
// 使用 Object.freeze 防止意外修改，并帮助 V8 优化
const DEFAULT_MODELS = Object.freeze([
  'claude-opus-4-6',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6-thinking',
  'gemini-3.1-pro-high',
  'gemini-2.5-flash-lite',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-4K',
  'gemini-3.1-flash-image-2K',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3.1-pro-low',
  'chat_20706',
  'rev19-uic3-1p',
  'gpt-oss-120b-medium',
  'chat_23310'
]);

// 生成默认模型列表响应
function getDefaultModelList() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: DEFAULT_MODELS.map(id => ({
      id,
      object: 'model',
      created,
      owned_by: 'google'
    }))
  };
}


// 注册对象池与模型缓存的内存清理回调
function registerMemoryCleanup() {
  // 由流式解析模块管理自身对象池大小
  registerStreamMemoryCleanup();

  // 统一由内存清理器定时触发：仅清理"已过期"的模型列表缓存
  memoryManager.registerCleanup(() => {
    const ttl = getModelCacheTTL();
    const now = Date.now();
    if (modelListCache && (now - modelListCacheTime) > ttl) {
      modelListCache = null;
      modelListCacheTime = 0;
    }
  });
}

// 初始化时注册清理回调
registerMemoryCleanup();

// ==================== 辅助函数 ====================

function buildHeaders(token, modelName = '') {
  const headers = {
    'Host': config.api.host,
    'User-Agent': config.api.userAgent,
    'Authorization': `Bearer ${token.access_token}`,
    'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
    'requestId': `req-${randomUUID()}`
  };
  // 根据模型名称设置请求类型（学习 gcli2api）
  if (modelName) {
    headers['requestType'] = modelName.toLowerCase().includes('image') ? 'image_gen' : 'agent';
  }
  return headers;
}

// 统一错误处理
async function handleApiError(error, token, dumpId = null) {
  const status = getUpstreamStatus(error);
  const errorBody = await readUpstreamErrorBody(error);

  if (dumpId) {
    await dumpFinalRawResponse(dumpId, String(errorBody ?? ''));
  }

  // 可配置的自动封禁错误码（学习 gcli2api 的 auto_ban 功能）
  const autoBanCodes = config.autoBan?.errorCodes || [403];
  const autoBanEnabled = config.autoBan?.enabled !== false;

  if (status === 403 && isCallerDoesNotHavePermission(errorBody)) {
    throw createApiError(`超出模型最大上下文。错误详情: ${errorBody}`, status, errorBody);
  }

  if (autoBanEnabled && autoBanCodes.includes(status)) {
    tokenManager.disableCurrentToken(token);
    throw createApiError(`错误码 ${status} 触发自动封禁，该账号已禁用。错误详情: ${errorBody}`, status, errorBody);
  }

  throw createApiError(`API请求失败 (${status}): ${errorBody}`, status, errorBody);
}


// ==================== 导出函数 ====================

export async function generateAssistantResponse(requestBody, token, callback) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token, modelName);
  const dumpId = isDebugDumpEnabled() ? createDumpId('stream') : null;
  const streamCollector = dumpId ? createStreamCollector() : null;
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));
  let num = Math.floor(Math.random() * QA_PAIRS.length);
  if (dumpId) {
    await dumpFinalRequest(dumpId, requestBody);
  }

  // 在 state 中临时缓存思维链签名，供流式多片段复用，并携带 session 与 model 信息以写入全局缓存
  const state = {
    toolCalls: [],
    reasoningSignature: null,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model
  };
  const processor = createStreamLineProcessor({
    state,
    onEvent: callback,
    onRawChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
  });

  try {
    await runSseStream({
      url: config.api.url,
      headers,
      body: requestBody,
      processor,
      onErrorChunk: (chunk) => collectStreamChunk(streamCollector, chunk)
    });

    // 流式响应结束后，以 JSON 格式写入日志
    if (dumpId) {
      await dumpStreamResponse(dumpId, streamCollector);
    }
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId,messageId,conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token,num,trajectoryId,conversationId,messageId).catch(err => logger.warn('发送log失败:', err.message));
    sendCheckPoint(token).catch(err => logger.warn('发送checkPoint失败:', err.message));;
  } catch (error) {
    try { processor.close(); } catch { }
    await handleApiError(error, token, dumpId);
  }
}

// 内部工具：从远端拉取完整模型原始数据
async function fetchRawModels(headers, token) {
  try {
    const { data } = await requesterManager.fetch(config.api.modelsUrl, {
      method: 'POST',
      headers,
      body: {},
    });
    return data;
  } catch (error) {
    await handleApiError(error, token);
  }
}

export async function getAvailableModels() {
  // 检查缓存是否有效（动态 TTL）
  const now = Date.now();
  const ttl = getModelCacheTTL();
  if (modelListCache && (now - modelListCacheTime) < ttl) {
    return modelListCache;
  }

  const token = await tokenManager.getToken();
  if (!token) {
    // 没有 token 时返回默认模型列表
    logger.warn('没有可用的 token，返回默认模型列表');
    return getDefaultModelList();
  }

  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) {
    // fetchRawModels 里已经做了统一错误处理，这里兜底为默认列表
    return getDefaultModelList();
  }

  const created = Math.floor(Date.now() / 1000);
  const modelList = Object.keys(data.models || {}).map(id => ({
    id,
    object: 'model',
    created,
    owned_by: 'google'
  }));

  // 添加默认模型（如果 API 返回的列表中没有）
  const existingIds = new Set(modelList.map(m => m.id));
  for (const defaultModel of DEFAULT_MODELS) {
    if (!existingIds.has(defaultModel)) {
      modelList.push({
        id: defaultModel,
        object: 'model',
        created,
        owned_by: 'google'
      });
    }
  }

  // 添加流式抗截断前缀版本（学习 gcli2api）— 放在默认模型之后，确保所有模型都有前缀版本
  const antiTruncModels = modelList.filter(m => !m.id.startsWith('流式抗截断/')).map(m => ({
    id: `流式抗截断/${m.id}`,
    object: 'model',
    created,
    owned_by: 'google'
  }));
  modelList.push(...antiTruncModels);

  const result = {
    object: 'list',
    data: modelList
  };

  // 更新缓存
  modelListCache = result;
  modelListCacheTime = now;
  const currentTTL = getModelCacheTTL();
  logger.info(`模型列表已缓存 (有效期: ${currentTTL / 1000}秒, 模型数量: ${modelList.length})`);

  return result;
}

// 清除模型列表缓存（可用于手动刷新）
export function clearModelListCache() {
  modelListCache = null;
  modelListCacheTime = 0;
  logger.info('模型列表缓存已清除');
}

export async function getModelsWithQuotas(token) {
  const headers = buildHeaders(token);
  const data = await fetchRawModels(headers, token);
  if (!data) return {};

  const quotas = {};
  Object.entries(data.models || {}).forEach(([modelId, modelData]) => {
    if (modelData.quotaInfo) {
      quotas[modelId] = {
        r: modelData.quotaInfo.remainingFraction,
        t: modelData.quotaInfo.resetTime
      };
    }
  });

  return quotas;
}

export async function generateAssistantResponseNoStream(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token, modelName);
  const dumpId = isDebugDumpEnabled() ? createDumpId('no_stream') : null;
  let num = Math.floor(Math.random() * QA_PAIRS.length);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody)));

  if (dumpId) await dumpFinalRequest(dumpId, requestBody);
  let data;
  try {
    data = await postJsonAndParse({
      url: config.api.noStreamUrl,
      headers,
      body: requestBody,
      dumpId,
      dumpFinalRawResponse,
      rawFormat: 'json'
    });
    sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
    sendRecordTrajectoryAnalytics(token, num, trajectoryId,messageId,conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
    sendLog(token,num,trajectoryId,conversationId,messageId).catch(err => logger.warn('发送log失败:', err.message));
  } catch (error) {
    await handleApiError(error, token, dumpId);
  }
  //console.log(JSON.stringify(data));
  // 空响应检测：200 但无有效内容时抛出错误（学习 gcli2api）
  if (!data || !data.response || !data.response.candidates || data.response.candidates.length === 0) {
    logger.warn('[generateNoStream] API 返回 200 但响应体为空或无 candidates');
    throw createApiError('API 返回空响应（200 但无有效内容），请重试', 500, JSON.stringify(data));
  }
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const parsed = parseGeminiCandidateParts({
    parts,
    sessionId: requestBody.request?.sessionId,
    model: requestBody.model,
    convertToToolCall,
    saveBase64Image
  });

  const usageData = toOpenAIUsage(data.response?.usageMetadata);

  // 将新的签名和思考内容写入全局缓存（按 model），供后续请求兜底使用
  const sessionId = requestBody.request?.sessionId;
  const model = requestBody.model;
  const hasTools = parsed.toolCalls.length > 0;
  const isImage = isImageModel(model);

  // 判断是否应该缓存签名
  if (sessionId && model && shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    // 获取最终使用的签名（优先使用工具签名，回退到思维签名）
    let finalSignature = parsed.reasoningSignature;

    // 工具签名：取最后一个带 thoughtSignature 的工具作为缓存源（更接近"最新"）
    if (hasTools) {
      for (let i = parsed.toolCalls.length - 1; i >= 0; i--) {
        const sig = parsed.toolCalls[i]?.thoughtSignature;
        if (sig) {
          finalSignature = sig;
          break;
        }
      }
    }

    if (finalSignature) {
      const cachedContent = parsed.reasoningContent || ' ';
      setSignature(sessionId, model, finalSignature, cachedContent, { hasTools, isImageModel: isImage });
    }
  }

  // 生图模型：转换为 markdown 格式
  if (parsed.imageUrls.length > 0) {
    let markdown = parsed.content ? parsed.content + '\n\n' : '';
    markdown += parsed.imageUrls.map(url => `![image](${url})`).join('\n\n');
    return { content: markdown, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
  }

  return { content: parsed.content, reasoningContent: parsed.reasoningContent, reasoningSignature: parsed.reasoningSignature, toolCalls: parsed.toolCalls, usage: usageData };
}

export async function generateImageForSD(requestBody, token) {
  startTokenTimer(token);
  const trajectoryId = requestBody.requestId.split('/')[2];
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const modelName = requestBody.model;
  const headers = buildHeaders(token, modelName);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody),'utf-8'));
  let num = Math.floor(Math.random() * QA_PAIRS.length);

  //console.log(JSON.stringify(requestBody,null,2));

  let data;
  try {
    const result = await requesterManager.fetch(config.api.noStreamUrl, {
      method: 'POST',
      headers,
      body: requestBody,
    });
    data = result.data;
  } catch (error) {
    await handleApiError(error, token);
  }
  sendRecordCodeAssistMetrics(token, trajectoryId).catch(err => logger.warn('发送RecordCodeAssistMetrics失败:', err.message));
  sendRecordTrajectoryAnalytics(token, num, trajectoryId,messageId,conversationId, modelName).catch(err => logger.warn('发送轨迹分析失败:', err.message));
  sendLog(token,num,trajectoryId,conversationId,messageId).catch(err => logger.warn('发送log失败:', err.message));

  // 空响应检测（学习 gcli2api）
  if (!data || !data.response || !data.response.candidates || data.response.candidates.length === 0) {
    logger.warn('[generateImageForSD] API 返回 200 但响应体为空');
    throw createApiError('图片生成 API 返回空响应', 500, JSON.stringify(data));
  }
  const parts = data.response?.candidates?.[0]?.content?.parts || [];
  const images = parts.filter(p => p.inlineData).map(p => p.inlineData.data);

  return images;
}

export async function sendRecordTrajectoryAnalytics(token, num, trajectoryId,executionId,cascadeId, modelName = "claude-opus-4-6-thinking") {
  const trajectorybody = generateTrajectorybody(num, trajectoryId,executionId,cascadeId, modelName, token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(trajectorybody)));
  try {
    await requesterManager.fetch(config.api.recordTrajectory, {
      method: 'POST',
      headers,
      body: trajectorybody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`轨迹分析请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

export async function sendLog(token, num, trajectoryId, conversationId,messageId) {
  const sessionId = trajectoryId;
  //const conversationId = randomUUID();
  
  const logs = [
    createLog2(conversationId, token, sessionId),
    createTelemetryBatch(num, sessionId,conversationId,messageId,token.sub),
    createLog1(conversationId, token, sessionId)
  ];
  
  const headers = buildHeaders(token);
  headers["Host"] = "play.googleapis.com";
  headers["User-Agent"] = "Go-http-client/1.1";
  headers["Content-Type"] = "application/octet-stream";
  headers["Accept-Encoding"] = "gzip";
  
  // TLS 请求器暂不支持二进制 body，此处固定使用 axios
  try {
    for (const log of logs) {
      const serializeData = serializeTelemetryBatch(log);
      if (!serializeData.success) {
        throw new Error(`Telemetry proto 序列化失败: ${serializeData.error}`);
      }
      const serializeLogBody = serializeData.data;
      headers["Content-Length"] = String(serializeLogBody.length);
      
      await axios({
        method: 'POST',
        url: "https://play.googleapis.com/log",
        headers,
        data: serializeLogBody
      });
    }
  } catch (error) {
    throw error;
  }
}

export async function sendRecordCodeAssistMetrics(token, trajectoryId) {
  const requestBody = buildRecordCodeAssistMetricsBody(token, trajectoryId);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody),'utf-8'));
  try {
    await requesterManager.fetch(config.api.recordCodeAssistMetrics, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200],
    });
  } catch (error) {
    throw new Error(`RecordCodeAssistMetrics请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

async function sendUnleashRequest({ method, url, headers, data = null, label, acceptedStatuses = [200, 202] }) {
  const axiosRequest = () => httpRequest({
    method,
    url,
    headers: { ...headers },
    ...(data !== null ? { data } : {})
  });

  try {
    await requesterManager.fetch(url, {
      method,
      headers: { ...headers },
      ...(data !== null ? { body: data } : {}),
      okStatus: acceptedStatuses
    });
  } catch (error) {
    if (!isTransientNetworkError(error) || !unleashControl.fallbackToAxios) {
      throw toUnleashError(label, error);
    }

    try {
      await axiosRequest();
    } catch (fallbackError) {
      throw toUnleashError(label, fallbackError);
    }
  }
}

export async function sendClientRegister(token) {
  const requestBody = buildClientRegister(token);
  const headers = buildClientRegisterHeaders(token);
  await sendUnleashRequest({
    method: 'POST',
    url: config.api.unleash.register,
    headers,
    data: requestBody,
    label: 'ClientRegister'
  });
}

export async function sendClientFeature(token) {
  const headers = buildClientFeatrueHeaders(token);
  await sendUnleashRequest({
    method: 'GET',
    url: config.api.unleash.features,
    headers,
    label: 'ClientFeature'
  });
}

export async function sendFrontEnd(token) {
  const requestBody = buildFrontEnd(token);
  const headers = buildFrontEndHeaders(token);
  await sendUnleashRequest({
    method: 'POST',
    url: config.api.unleash.frontend,
    headers,
    data: requestBody,
    label: 'FrontEnd'
  });
}

export async function sendCheckPoint(token) {
  const requestBody = generateCheckpointBody(token);
  const headers = buildHeaders(token);
  headers["Content-Length"] = String(Buffer.byteLength(JSON.stringify(requestBody),'utf-8'));
  if (checkPointList.has(token.sessionId)){
    return;
  }else{
    checkPointList.add(token.sessionId);
  }
  try {
    await requesterManager.fetch(config.api.url, {
      method: 'POST',
      headers,
      body: requestBody,
      okStatus: [200, 202],
    });
  } catch (error) {
    throw new Error(`CheckPoint请求失败 (${error.status ?? ''}): ${error.message}`);
  }
}

// 导出内存清理注册函数（供外部调用）
export { registerMemoryCleanup };

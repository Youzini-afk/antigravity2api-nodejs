/**
 * OpenAI 格式处理器
 * 处理 /v1/chat/completions 请求，支持流式和非流式响应
 */

import { isAntiTruncationModel, getBaseModelName, AntiTruncationStreamProcessor, applyAntiTruncation } from '../../utils/antiTruncation.js';
import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import {
  createOpenAIStreamChunk as createStreamChunk,
  createOpenAIChatCompletionResponse
} from '../formatters/openai.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  writeStreamData,
  endStream,
  with429Retry
} from '../stream.js';

/**
 * 处理 OpenAI 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleOpenAIRequest = async (req, res) => {
  const body = req.body || {};
  const { messages, model, stream = false, tools, ...params } = body;
  const errorOptions = { scope: 'openai' };

  try {
    const validation = validateIncomingChatRequest('openai', body);
    if (!validation.ok) {
      return res.status(validation.status).json(
        buildOpenAIErrorPayload({ message: validation.message, type: 'invalid_request_error' }, validation.status, errorOptions)
      );
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json(
        buildOpenAIErrorPayload({ message: 'model is required', type: 'invalid_request_error' }, 400, errorOptions)
      );
    }

    // 流式抗截断检测（学习 gcli2api）
    const useAntiTruncation = isAntiTruncationModel(model);
    const actualModel = useAntiTruncation ? getBaseModelName(model) : model;

    const bypassThreshold = req.apiAuthContext?.isBypassThreshold === true;
    const token = await tokenManager.getToken(actualModel, { bypassThreshold });

    // 获取 tokenId 用于冷却状态管理
    const tokenId = await tokenManager.getTokenId(token);
    

    // 创建刷新额度的回调函数
    const refreshQuota = async () => {
      if (!tokenId) return;
      const quotas = await getModelsWithQuotas(token);
      quotaManager.updateQuota(tokenId, quotas);
    };

    // 创建 with429Retry 选项
    const createRetryOptions = (prefix) => ({
      loggerPrefix: prefix,
      onAttempt: () => tokenManager.recordRequest(token, actualModel),
      tokenId,
      modelId: actualModel,
      refreshQuota,
      tokenManager,
      token
    });

    const isImageModel = actualModel.includes('-image');
    const requestBody = generateRequestBody(messages, actualModel, params, tools, token);

    if (isImageModel) {
      prepareImageRequest(requestBody);
    }
    //console.log(JSON.stringify(requestBody,null,2));
    const { id, created } = createResponseMeta();
    const safeRetries = getSafeRetries(config.retryTimes);

    if (stream) {
      setStreamHeaders(res);

      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage, reasoningSignature } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            createRetryOptions('chat.stream.image ')
          );
          const delta = { content };
          if (reasoningSignature && config.passSignatureToClient) {
            delta.thoughtSignature = reasoningSignature;
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;

          // 提取流式回调（抗截断和正常模式共用）
          const onStreamEvent = (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              const delta = { reasoning_content: data.reasoning_content };
              if (data.thoughtSignature && config.passSignatureToClient) {
                delta.thoughtSignature = data.thoughtSignature;
              }
              writeStreamData(res, createStreamChunk(id, created, model, delta));
            } else if (data.type === 'tool_calls') {
              hasToolCall = true;
              const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                if (config.passSignatureToClient) {
                  return { index, ...toolCall };
                } else {
                  const { thoughtSignature, ...rest } = toolCall;
                  return { index, ...rest };
                }
              });
              const delta = { tool_calls: toolCallsWithIndex };
              writeStreamData(res, createStreamChunk(id, created, model, delta));
            } else {
              const delta = { content: data.content };
              writeStreamData(res, createStreamChunk(id, created, model, delta));
            }
          };

          if (useAntiTruncation) {
            // 抗截断模式：用 AntiTruncationStreamProcessor 包装流式请求
            const processor = new AntiTruncationStreamProcessor(
              (payload, cb) => with429Retry(
                () => generateAssistantResponse(payload, token, cb),
                safeRetries,
                createRetryOptions('chat.stream.anti_trunc ')
              ),
              requestBody
            );
            await processor.run(onStreamEvent);
          } else {
            await with429Retry(
              () => generateAssistantResponse(requestBody, token, onStreamEvent),
              safeRetries,
              createRetryOptions('chat.stream ')
            );
          }

          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          writeStreamData(res, buildOpenAIErrorPayload(error, statusCode, errorOptions));
          endStream(res);
        }
        logger.error('生成响应失败:', error.message);
        return;
      }
    } else if (config.fakeNonStream && !isImageModel) {
      // 假非流模式：使用流式API获取数据，组装成非流式响应
      req.setTimeout(0);
      res.setTimeout(0);

      let content = '';
      let reasoningContent = '';
      let reasoningSignature = null;
      const toolCalls = [];
      let usageData = null;

      try {
        await with429Retry(
          () => generateAssistantResponse(requestBody, token, (data) => {
            if (data.type === 'usage') {
              usageData = data.usage;
            } else if (data.type === 'reasoning') {
              reasoningContent += data.reasoning_content || '';
              if (data.thoughtSignature) {
                reasoningSignature = data.thoughtSignature;
              }
            } else if (data.type === 'tool_calls') {
              toolCalls.push(...data.tool_calls);
            } else if (data.type === 'text') {
              content += data.content || '';
            }
          }),
          safeRetries,
          createRetryOptions('chat.fake_no_stream ')
        );

        // 构建非流式响应
        const message = { role: 'assistant' };
        if (reasoningContent) message.reasoning_content = reasoningContent;
        if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
        message.content = content;

        if (toolCalls.length > 0) {
          if (config.passSignatureToClient) {
            message.tool_calls = toolCalls;
          } else {
            message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
          }
        }

        res.json(createOpenAIChatCompletionResponse({
          id,
          created,
          model,
          content,
          reasoningContent,
          reasoningSignature,
          toolCalls,
          usage: usageData,
          passSignatureToClient: config.passSignatureToClient,
          stripToolCallSignature: !config.passSignatureToClient
        }));
      } catch (error) {
        logger.error('假非流生成响应失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode, errorOptions));
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        createRetryOptions('chat.no_stream ')
      );

      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;

      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }

      // 使用预构建的响应对象，减少内存分配
      res.json(createOpenAIChatCompletionResponse({
        id,
        created,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        usage,
        passSignatureToClient: config.passSignatureToClient,
        stripToolCallSignature: !config.passSignatureToClient
      }));
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode, errorOptions));
  }
};

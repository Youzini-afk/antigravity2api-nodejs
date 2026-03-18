/**
 * Claude 格式处理器
 * 处理 /v1/messages 请求，支持流式和非流式响应
 */

import { isAntiTruncationModel, getBaseModelName, AntiTruncationStreamProcessor, applyAntiTruncation } from '../../utils/antiTruncation.js';
import { generateAssistantResponse, generateAssistantResponseNoStream, getModelsWithQuotas } from '../../api/client.js';
import { generateClaudeRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { normalizeClaudeParameters } from '../../utils/parameterNormalizer.js';
import { buildClaudeErrorPayload } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import quotaManager from '../../auth/quota_manager.js';
import { createClaudeResponse } from '../formatters/claude.js';
import { validateIncomingChatRequest } from '../validators/chat.js';
import { getSafeRetries } from './common/retry.js';
import {
  setStreamHeaders,
  createHeartbeat,
  with429Retry
} from '../stream.js';

/**
 * 创建 Claude 流式事件
 * @param {string} eventType - 事件类型
 * @param {Object} data - 事件数据
 * @returns {string}
 */
export const createClaudeStreamEvent = (eventType, data) => {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
};

/**
 * 创建 Claude 非流式响应
 * @param {string} id - 消息ID
 * @param {string} model - 模型名称
 * @param {string|null} content - 文本内容
 * @param {string|null} reasoning - 思维链内容
 * @param {string|null} reasoningSignature - 思维链签名
 * @param {Array|null} toolCalls - 工具调用
 * @param {string} stopReason - 停止原因
 * @param {Object|null} usage - 使用量统计
 * @returns {Object}
 */

/**
 * 处理 Claude 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 * @param {boolean} isStream - 是否流式响应
 */
export const handleClaudeRequest = async (req, res, isStream) => {
  const body = req.body || {};
  const { messages, model, system, tools, ...rawParams } = body;
  const errorOptions = { scope: 'claude' };

  try {
    const validation = validateIncomingChatRequest('claude', body);
    if (!validation.ok) {
      return res.status(validation.status).json(buildClaudeErrorPayload({ message: validation.message }, validation.status, errorOptions));
    }
    if (typeof model !== 'string' || !model) {
      return res.status(400).json(buildClaudeErrorPayload({ message: 'model is required' }, 400, errorOptions));
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
      refreshQuota
    });

    // 使用统一参数规范化模块处理 Claude 格式参数
    const parameters = normalizeClaudeParameters(rawParams);

    const isImageModel = actualModel.includes('-image');
    const requestBody = generateClaudeRequestBody(messages, actualModel, parameters, tools, system, token);

    if (isImageModel) {
      prepareImageRequest(requestBody);
    }

    const msgId = `msg_${Date.now()}`;
    const safeRetries = getSafeRetries(config.retryTimes);

    if (isStream) {
      setStreamHeaders(res);
      const heartbeatTimer = createHeartbeat(res);

      try {
        let contentIndex = 0;
        let usageData = null;
        let hasToolCall = false;
        let currentBlockType = null;
        let reasoningSent = false;

        // 发送 message_start
        res.write(createClaudeStreamEvent('message_start', {
          type: "message_start",
          message: {
            id: msgId,
            type: "message",
            role: "assistant",
            content: [],
            model: model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        }));

        if (isImageModel) {
          // 生图模型：使用非流式获取结果后以流式格式返回
          const { content, usage } = await with429Retry(
            () => generateAssistantResponseNoStream(requestBody, token),
            safeRetries,
            createRetryOptions('claude.stream.image ')
          );

          // 发送文本块
          res.write(createClaudeStreamEvent('content_block_start', {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" }
          }));
          res.write(createClaudeStreamEvent('content_block_delta', {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: content || '' }
          }));
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: 0
          }));

          // 发送 message_delta 和 message_stop
          res.write(createClaudeStreamEvent('message_delta', {
            type: "message_delta",
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: usage ? { output_tokens: usage.completion_tokens || 0 } : { output_tokens: 0 }
          }));
          res.write(createClaudeStreamEvent('message_stop', {
            type: "message_stop"
          }));

          clearInterval(heartbeatTimer);
          res.end();
          return;
        }

        // 提取流式回调（抗截断和正常模式共用）
        const onStreamEvent = (data) => {
          if (data.type === 'usage') {
            usageData = data.usage;
          } else if (data.type === 'reasoning') {
            if (!reasoningSent) {
              if (currentBlockType === 'text') {
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
                currentBlockType = null;
              }
              const contentBlock = { type: "thinking", thinking: "" };
              if (data.thoughtSignature && config.passSignatureToClient) {
                contentBlock.signature = data.thoughtSignature;
              }
              res.write(createClaudeStreamEvent('content_block_start', {
                type: "content_block_start",
                index: contentIndex,
                content_block: contentBlock
              }));
              currentBlockType = 'thinking';
              reasoningSent = true;
            }
            const delta = { type: "thinking_delta", thinking: data.reasoning_content || '' };
            if (data.thoughtSignature && config.passSignatureToClient) {
              delta.signature = data.thoughtSignature;
            }
            res.write(createClaudeStreamEvent('content_block_delta', {
              type: "content_block_delta",
              index: contentIndex,
              delta: delta
            }));
          } else if (data.type === 'tool_calls') {
            hasToolCall = true;
            if (currentBlockType) {
              res.write(createClaudeStreamEvent('content_block_stop', {
                type: "content_block_stop",
                index: contentIndex
              }));
              contentIndex++;
            }
            for (const tc of data.tool_calls) {
              try {
                const inputObj = JSON.parse(tc.function.arguments);
                const toolContentBlock = { type: "tool_use", id: tc.id, name: tc.function.name, input: {} };
                if (tc.thoughtSignature && config.passSignatureToClient) {
                  toolContentBlock.signature = tc.thoughtSignature;
                }
                res.write(createClaudeStreamEvent('content_block_start', {
                  type: "content_block_start",
                  index: contentIndex,
                  content_block: toolContentBlock
                }));
                res.write(createClaudeStreamEvent('content_block_delta', {
                  type: "content_block_delta",
                  index: contentIndex,
                  delta: { type: "input_json_delta", partial_json: JSON.stringify(inputObj) }
                }));
                res.write(createClaudeStreamEvent('content_block_stop', {
                  type: "content_block_stop",
                  index: contentIndex
                }));
                contentIndex++;
              } catch (e) {
                // 解析失败，跳过
              }
            }
            currentBlockType = null;
          } else {
            const textContent = data.content || '';
            if (!reasoningSent && !textContent) {
              return;
            }
            if (currentBlockType === 'thinking') {
              res.write(createClaudeStreamEvent('content_block_stop', {
                type: "content_block_stop",
                index: contentIndex
              }));
              contentIndex++;
              currentBlockType = null;
            }
            if (currentBlockType !== 'text') {
              res.write(createClaudeStreamEvent('content_block_start', {
                type: "content_block_start",
                index: contentIndex,
                content_block: { type: "text", text: "" }
              }));
              currentBlockType = 'text';
            }
            res.write(createClaudeStreamEvent('content_block_delta', {
              type: "content_block_delta",
              index: contentIndex,
              delta: { type: "text_delta", text: textContent }
            }));
          }
        };

        if (useAntiTruncation) {
          const processor = new AntiTruncationStreamProcessor(
            (payload, cb) => with429Retry(
              () => generateAssistantResponse(payload, token, cb),
              safeRetries,
              createRetryOptions('claude.stream.anti_trunc ')
            ),
            requestBody
          );
          await processor.run(onStreamEvent);
        } else {
          await with429Retry(
            () => generateAssistantResponse(requestBody, token, onStreamEvent),
            safeRetries,
            createRetryOptions('claude.stream ')
          );
        }

        // 结束最后一个内容块
        if (currentBlockType) {
          res.write(createClaudeStreamEvent('content_block_stop', {
            type: "content_block_stop",
            index: contentIndex
          }));
        }

        // 发送 message_delta
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        res.write(createClaudeStreamEvent('message_delta', {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: usageData ? { output_tokens: usageData.completion_tokens || 0 } : { output_tokens: 0 }
        }));

        // 发送 message_stop
        res.write(createClaudeStreamEvent('message_stop', {
          type: "message_stop"
        }));

        clearInterval(heartbeatTimer);
        res.end();
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          res.write(createClaudeStreamEvent('error', buildClaudeErrorPayload(error, statusCode, errorOptions)));
          res.end();
        }
        logger.error('Claude 流式请求失败:', error.message);
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
          createRetryOptions('claude.fake_no_stream ')
        );

        const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
        const response = createClaudeResponse(
          msgId,
          model,
          content,
          reasoningContent || null,
          reasoningSignature,
          toolCalls,
          stopReason,
          usageData,
          { passSignatureToClient: config.passSignatureToClient }
        );

        res.json(response);
      } catch (error) {
        logger.error('Claude 假非流请求失败:', error.message);
        if (res.headersSent) return;
        const statusCode = error.statusCode || error.status || 500;
        res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode, errorOptions));
      }
    } else {
      // 非流式请求
      req.setTimeout(0);
      res.setTimeout(0);

      const { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        () => generateAssistantResponseNoStream(requestBody, token),
        safeRetries,
        createRetryOptions('claude.no_stream ')
      );

      const stopReason = toolCalls.length > 0 ? 'tool_use' : 'end_turn';
      const response = createClaudeResponse(
        msgId,
        model,
        content,
        reasoningContent,
        reasoningSignature,
        toolCalls,
        stopReason,
        usage,
        { passSignatureToClient: config.passSignatureToClient }
      );

      res.json(response);
    }
  } catch (error) {
    logger.error('Claude 请求失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    res.status(statusCode).json(buildClaudeErrorPayload(error, statusCode, errorOptions));
  }
};

/**
 * Anti-Truncation Module — 流式抗截断
 * 
 * 核心功能：检测流式输出是否被截断，自动发送续写请求拼接后续内容。
 * 
 * 机制：
 * 1. 在 systemInstruction 中注入 [done] 标记指令
 * 2. 监控流式输出中是否出现 [done]
 * 3. 流结束但未见 [done] → 将已收集内容追加到对话 + 续写 prompt → 重新请求
 * 4. 从输出中剥离 [done] 标记
 * 5. 最多 N 次续写尝试（默认 3）
 * 
 * 学习自 gcli2api/src/converter/anti_truncation.py
 */

import logger from './logger.js';
import config from '../config/config.js';

// ==================== 常量 ====================

export const DONE_MARKER = '[done]';

const ANTI_TRUNCATION_PREFIX = '流式抗截断/';

const SYSTEM_INSTRUCTION = `严格执行以下输出结束规则：

1. 当你完成完整回答时，必须在输出的最后单独一行输出：${DONE_MARKER}
2. ${DONE_MARKER} 标记表示你的回答已经完全结束，这是必需的结束标记
3. 只有输出了 ${DONE_MARKER} 标记，系统才认为你的回答是完整的
4. 如果你的回答被截断，系统会要求你继续输出剩余内容
5. 无论回答长短，都必须以 ${DONE_MARKER} 标记结束

注意：${DONE_MARKER} 必须单独占一行，前面不要有任何其他字符。
这个规则对于确保输出完整性极其重要，请严格遵守。`;

const CONTINUATION_PROMPT_TEMPLATE = `请从刚才被截断的地方继续输出剩余的所有内容。

重要提醒：
1. 不要重复前面已经输出的内容
2. 直接继续输出，无需任何前言或解释
3. 当你完整完成所有内容输出后，必须在最后一行单独输出：${DONE_MARKER}
4. ${DONE_MARKER} 标记表示你的回答已经完全结束，这是必需的结束标记

现在请继续输出：`;

// ==================== 工具函数 ====================

/**
 * 检查模型名是否使用了抗截断前缀
 * @param {string} modelName
 * @returns {boolean}
 */
export function isAntiTruncationModel(modelName) {
  return typeof modelName === 'string' && modelName.startsWith(ANTI_TRUNCATION_PREFIX);
}

/**
 * 从带前缀的模型名中提取基础模型名
 * @param {string} modelName
 * @returns {string}
 */
export function getBaseModelName(modelName) {
  if (isAntiTruncationModel(modelName)) {
    return modelName.slice(ANTI_TRUNCATION_PREFIX.length);
  }
  return modelName;
}

/**
 * 检查文本中是否包含 DONE_MARKER
 * @param {string} text
 * @returns {boolean}
 */
function checkDoneMarker(text) {
  if (!text) return false;
  return text.toLowerCase().includes(DONE_MARKER);
}

/**
 * 从文本中移除 DONE_MARKER（忽略大小写，包含前后空白）
 * @param {string} text
 * @returns {string}
 */
function removeDoneMarker(text) {
  if (!text) return text;
  return text.replace(/\s*\[done\]\s*/gi, '');
}

/**
 * 获取最大续写尝试次数
 * @returns {number}
 */
function getMaxAttempts() {
  return config.antiTruncation?.maxAttempts || 3;
}

// ==================== 请求体预处理 ====================

/**
 * 在请求体中注入抗截断 system instruction
 * @param {Object} requestBody - Antigravity API 请求体
 * @returns {Object} 修改后的请求体（浅拷贝）
 */
export function applyAntiTruncation(requestBody) {
  const modified = { ...requestBody };
  const request = { ...(modified.request || {}) };

  // 获取或创建 systemInstruction
  let sysInst = request.systemInstruction
    ? { ...request.systemInstruction }
    : { parts: [] };

  if (!sysInst.parts) {
    sysInst.parts = [];
  }

  // 检查是否已包含抗截断指令
  const alreadyHas = sysInst.parts.some(
    p => typeof p.text === 'string' && p.text.includes(DONE_MARKER)
  );

  if (!alreadyHas) {
    sysInst.parts = [...sysInst.parts, { text: SYSTEM_INSTRUCTION }];
    logger.debug('[AntiTruncation] 已注入 [done] 标记指令到 systemInstruction');
  }

  request.systemInstruction = sysInst;
  modified.request = request;
  return modified;
}

// ==================== 流式处理器 ====================

/**
 * 抗截断流式处理器
 * 
 * 使用方式：
 * ```
 * const processor = new AntiTruncationStreamProcessor(
 *   (body) => generateAssistantResponse(body, token, cb),
 *   requestBody
 * );
 * await processor.run(callback);
 * ```
 */
export class AntiTruncationStreamProcessor {
  /**
   * @param {Function} streamRequestFn - 接收 (requestBody, callback) 的流式请求函数
   * @param {Object} baseRequestBody - 原始请求体
   * @param {number} [maxAttempts] - 最大尝试次数
   */
  constructor(streamRequestFn, baseRequestBody, maxAttempts) {
    this.streamRequestFn = streamRequestFn;
    this.baseRequestBody = baseRequestBody;
    this.maxAttempts = maxAttempts || getMaxAttempts();
    this.collectedContent = '';
    this.currentAttempt = 0;
  }

  /**
   * 执行抗截断流式处理
   * @param {Function} onEvent - 事件回调（与原始 callback 签名相同）
   * @returns {Promise<void>}
   */
  async run(onEvent) {
    while (this.currentAttempt < this.maxAttempts) {
      this.currentAttempt++;
      const currentPayload = this._buildPayload();
      let foundDoneMarker = false;
      let chunkContent = '';

      logger.debug(`[AntiTruncation] 第 ${this.currentAttempt}/${this.maxAttempts} 次尝试`);

      try {
        // 用一个包装 callback 来拦截流式事件
        await this.streamRequestFn(currentPayload, (data) => {
          // 提取文本内容用于截断检测
          const extracted = this._extractText(data);
          if (extracted) {
            chunkContent += extracted;
            if (checkDoneMarker(extracted)) {
              foundDoneMarker = true;
            }
          }

          // 清理 [done] 标记后再转发给客户端
          const cleaned = this._cleanEvent(data);
          if (cleaned) {
            onEvent(cleaned);
          }
        });

        // 流式结束，检查是否完成
        this.collectedContent += chunkContent;

        if (foundDoneMarker || checkDoneMarker(this.collectedContent)) {
          logger.info(`[AntiTruncation] 检测到 [done] 标记，输出完成（第 ${this.currentAttempt} 次尝试）`);
          return; // 完成
        }

        // 没有 [done] 标记
        if (this.currentAttempt < this.maxAttempts) {
          logger.warn(
            `[AntiTruncation] 未检测到 [done] 标记（已收集 ${this.collectedContent.length} 字符），` +
            `准备第 ${this.currentAttempt + 1} 次续写...`
          );
          continue; // 下一轮
        }

        // 最后一次尝试也没有标记
        logger.warn(`[AntiTruncation] 达到最大尝试次数 ${this.maxAttempts}，结束流`);
        return;

      } catch (error) {
        // 收集本轮已获得的内容
        this.collectedContent += chunkContent;

        if (this.currentAttempt >= this.maxAttempts) {
          logger.error(`[AntiTruncation] 第 ${this.currentAttempt} 次尝试出错: ${error.message}`);
          throw error;
        }
        logger.warn(`[AntiTruncation] 第 ${this.currentAttempt} 次尝试出错，重试: ${error.message}`);
      }
    }

    logger.error('[AntiTruncation] 所有尝试均失败');
  }

  /**
   * 用于非流式模式的抗截断
   * @param {Function} noStreamRequestFn - 接收 requestBody 返回结果的非流式请求函数
   * @returns {Promise<Object>} 最终结果
   */
  async runNonStream(noStreamRequestFn) {
    while (this.currentAttempt < this.maxAttempts) {
      this.currentAttempt++;
      const currentPayload = this._buildPayload();

      try {
        const result = await noStreamRequestFn(currentPayload);

        // 从结果中检测 done 标记
        const content = result?.content || '';
        this.collectedContent += content;

        if (checkDoneMarker(content) || checkDoneMarker(this.collectedContent)) {
          // 清理标记
          result.content = removeDoneMarker(result.content || '');
          logger.info(`[AntiTruncation] 非流式模式检测到 [done]，输出完成`);
          return result;
        }

        if (this.currentAttempt < this.maxAttempts) {
          logger.warn(`[AntiTruncation] 非流式模式未检测到 [done]，准备续写...`);
          continue;
        }

        // 最后一次尝试
        logger.warn(`[AntiTruncation] 非流式模式达到最大尝试次数`);
        return result;

      } catch (error) {
        if (this.currentAttempt >= this.maxAttempts) throw error;
        logger.warn(`[AntiTruncation] 非流式第 ${this.currentAttempt} 次出错，重试: ${error.message}`);
      }
    }
  }

  /**
   * 构建当前请求 payload
   * @returns {Object}
   * @private
   */
  _buildPayload() {
    if (this.currentAttempt === 1) {
      // 第一次：使用注入了抗截断指令的原始 payload
      return applyAntiTruncation(this.baseRequestBody);
    }

    // 续写请求：追加已收集内容 + 续写提示
    const payload = applyAntiTruncation(this.baseRequestBody);
    const request = { ...(payload.request || {}) };
    const contents = [...(request.contents || [])];

    // 追加前面模型输出
    if (this.collectedContent) {
      contents.push({
        role: 'model',
        parts: [{ text: this.collectedContent }]
      });
    }

    // 构建续写提示（包含已输出内容的摘要）
    let contentSummary = '';
    if (this.collectedContent) {
      if (this.collectedContent.length > 200) {
        contentSummary = `\n\n前面你已经输出了约 ${this.collectedContent.length} 个字符的内容，结尾是：\n"...${this.collectedContent.slice(-100)}"`;
      } else {
        contentSummary = `\n\n前面你已经输出的内容是：\n"${this.collectedContent}"`;
      }
    }

    contents.push({
      role: 'user',
      parts: [{ text: CONTINUATION_PROMPT_TEMPLATE + contentSummary }]
    });

    request.contents = contents;
    payload.request = request;
    return payload;
  }

  /**
   * 从流式事件中提取纯文本内容
   * @param {Object} data - 流式事件数据
   * @returns {string}
   * @private
   */
  _extractText(data) {
    if (!data) return '';
    // 支持 streamLineProcessor 回调的数据格式
    if (data.type === 'text') return data.content || '';
    if (data.type === 'reasoning') return ''; // 思维链内容不计入
    if (data.type === 'tool_calls') return ''; // 工具调用不计入
    if (data.type === 'usage') return '';
    // 兜底：尝试 content 字段
    return data.content || '';
  }

  /**
   * 清理事件中的 [done] 标记
   * @param {Object} data - 流式事件数据
   * @returns {Object|null} 清理后的事件，或 null（如果清理后为空）
   * @private
   */
  _cleanEvent(data) {
    if (!data) return data;

    // text 类型事件：清理 [done]
    if (data.type === 'text' && typeof data.content === 'string') {
      const cleaned = removeDoneMarker(data.content);
      if (!cleaned && data.content) {
        // 整个内容就是 [done] 标记，跳过此事件
        return null;
      }
      return { ...data, content: cleaned };
    }

    // 其他类型的事件，直接透传
    return data;
  }
}

export default {
  DONE_MARKER,
  ANTI_TRUNCATION_PREFIX,
  isAntiTruncationModel,
  getBaseModelName,
  applyAntiTruncation,
  AntiTruncationStreamProcessor
};

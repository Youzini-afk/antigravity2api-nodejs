/**
 * 外部模型代理
 * 将请求转发到用户配置的 OpenAI 兼容 API
 */

import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * 将拦截到的请求转发给外部 OpenAI 兼容 API
 * @param {Object} options
 * @param {Object} options.body - 原始请求体
 * @param {boolean} options.stream - 是否流式
 * @param {Object} options.res - Express response 对象
 * @param {string} options.reason - 拦截原因（用于日志）
 */
export async function proxyToExternal({ body, stream, res, reason }) {
  const ext = config.requestInterception?.external;
  if (!ext?.baseUrl || !ext?.model) {
    logger.warn(`[ExternalProxy] 外部模型未配置，无法转发 (reason=${reason})`);
    return res.status(503).json({
      error: { message: '外部模型未配置，请在管理面板设置外部 API', type: 'server_error', code: 'external_not_configured' }
    });
  }

  const url = `${ext.baseUrl}/chat/completions`;
  const messages = [];

  // 注入系统提示词
  if (ext.systemPrompt) {
    messages.push({ role: 'system', content: ext.systemPrompt });
  }

  // 复制原始消息（过滤掉不合规的结构问题）
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg.role && msg.content !== undefined) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  const requestBody = {
    model: ext.model,
    messages,
    stream,
    temperature: ext.temperature ?? 0.7,
    max_tokens: ext.maxTokens ?? 4096
  };

  const headers = {
    'Content-Type': 'application/json'
  };
  if (ext.apiKey) {
    headers['Authorization'] = `Bearer ${ext.apiKey}`;
  }

  logger.info(`[ExternalProxy] 转发请求到外部模型 (reason=${reason}, model=${ext.model}, stream=${stream})`);

  try {
    const fetchResponse = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    if (!fetchResponse.ok) {
      const errText = await fetchResponse.text().catch(() => 'unknown error');
      logger.error(`[ExternalProxy] 外部 API 返回错误: ${fetchResponse.status} ${errText.substring(0, 200)}`);
      return res.status(fetchResponse.status).json({
        error: { message: `外部模型返回错误: ${fetchResponse.status}`, type: 'upstream_error', code: 'external_api_error' }
      });
    }

    if (stream) {
      // 流式：直接 pipe 响应
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const reader = fetchResponse.body;
      if (reader && typeof reader.pipe === 'function') {
        reader.pipe(res);
      } else if (reader && reader[Symbol.asyncIterator]) {
        // Node.js fetch 返回 ReadableStream
        for await (const chunk of reader) {
          res.write(chunk);
        }
        res.end();
      } else {
        // fallback: 读取全部内容
        const text = await fetchResponse.text();
        res.write(text);
        res.end();
      }
    } else {
      // 非流式：直接返回 JSON
      const data = await fetchResponse.json();
      res.json(data);
    }
  } catch (error) {
    logger.error(`[ExternalProxy] 转发失败: ${error.message}`);
    res.status(502).json({
      error: { message: `外部模型请求失败: ${error.message}`, type: 'upstream_error', code: 'external_proxy_error' }
    });
  }
}

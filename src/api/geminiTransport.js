import requesterManager from '../utils/requesterManager.js';

/**
 * 统一流式 SSE 请求（TLS 指纹 / axios 均通过 requesterManager 路由）
 *
 * streamResponse 实现 onStart/onData/onEnd/onError 链式接口
 * （TLS 路径返回 src/requester.js StreamResponse，
 *  axios 路径返回 requesterManager 内部的 AxiosStreamResponse）
 */
export async function runSseStream({ url, method = 'POST', headers, body, processor, onErrorChunk } = {}) {
  const streamResponse = await requesterManager.fetchStream(url, { method, headers, body });

  let errorBody = '';
  let statusCode = null;

  await new Promise((resolve, reject) => {
    streamResponse
      .onStart(({ status }) => {
        statusCode = status;
      })
      .onData((chunk) => {
        if (statusCode !== 200) {
          errorBody += chunk;
          if (onErrorChunk) onErrorChunk(chunk);
        } else {
          processor.processChunk(chunk);
        }
      })
      .onEnd(() => {
        processor.close();
        if (statusCode !== 200) {
          reject({ status: statusCode, message: errorBody });
        } else {
          resolve();
        }
      })
      .onError(reject);
  });
}

/**
 * 发送 JSON 请求并解析响应（非流式）
 *
 * @param {object} options
 * @param {string}   options.url
 * @param {object}   options.headers
 * @param {*}        options.body
 * @param {string}   [options.dumpId]
 * @param {Function} [options.dumpFinalRawResponse]
 * @param {string}   [options.rawFormat='json']
 * @returns {Promise<any>} 解析后的 JSON 数据
 */
export async function postJsonAndParse({
  url,
  headers,
  body,
  dumpId,
  dumpFinalRawResponse,
  rawFormat = 'json',
} = {}) {
  const { data } = await requesterManager.fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (dumpId) {
    const rawText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    await dumpFinalRawResponse(dumpId, rawText, rawFormat);
    return typeof data === 'string' ? JSON.parse(data) : data;
  }

  return data;
}

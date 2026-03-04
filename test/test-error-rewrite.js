import assert from 'assert';
import config from '../src/config/config.js';
import { rewriteErrorPayloadMessage } from '../src/utils/errorRewrite.js';
import { buildGeminiErrorPayload, buildOpenAIErrorPayload, createApiError } from '../src/utils/errors.js';

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function run() {
  const originalPolicy = clone(config.errorRewrite);

  try {
    const basePayload = {
      error: {
        message: 'API请求失败 (429): RESOURCE_EXHAUSTED',
        type: 'upstream_api_error',
        code: 429
      }
    };

    // case 1: disabled -> no rewrite
    config.errorRewrite = { enabled: false, rules: [] };
    let result = rewriteErrorPayloadMessage(clone(basePayload), {
      payloadType: 'openai',
      scope: 'openai',
      statusCode: 429,
      error: { rawBody: 'RESOURCE_EXHAUSTED' },
      message: basePayload.error.message,
      type: basePayload.error.type,
      code: basePayload.error.code
    });
    assert.strictEqual(result.error.message, basePayload.error.message);

    // case 2: and rule hit -> replace
    config.errorRewrite = {
      enabled: true,
      rules: [
        {
          id: 'rule-hit',
          enabled: true,
          logic: 'and',
          scope: ['openai'],
          match: {
            statusCodes: [429],
            typeExact: ['upstream_api_error'],
            codeExact: ['429'],
            messageExact: [],
            messageContains: ['API请求失败'],
            rawExact: [],
            rawContains: ['RESOURCE_EXHAUSTED']
          },
          rewrite: {
            mode: 'replace',
            message: '当前请求较多，请稍后重试。'
          }
        }
      ]
    };
    result = rewriteErrorPayloadMessage(clone(basePayload), {
      payloadType: 'openai',
      scope: 'openai',
      statusCode: 429,
      error: { rawBody: 'RESOURCE_EXHAUSTED' },
      message: basePayload.error.message,
      type: basePayload.error.type,
      code: basePayload.error.code
    });
    assert.strictEqual(result.error.message, '当前请求较多，请稍后重试。');

    // case 3: first-match wins
    config.errorRewrite = {
      enabled: true,
      rules: [
        {
          id: 'rule-first',
          enabled: true,
          logic: 'or',
          scope: ['openai'],
          match: {
            statusCodes: [429],
            typeExact: [],
            codeExact: [],
            messageExact: [],
            messageContains: [],
            rawExact: [],
            rawContains: []
          },
          rewrite: { mode: 'replace', message: 'first' }
        },
        {
          id: 'rule-second',
          enabled: true,
          logic: 'or',
          scope: ['openai'],
          match: {
            statusCodes: [429],
            typeExact: [],
            codeExact: [],
            messageExact: [],
            messageContains: [],
            rawExact: [],
            rawContains: []
          },
          rewrite: { mode: 'replace', message: 'second' }
        }
      ]
    };
    result = rewriteErrorPayloadMessage(clone(basePayload), {
      payloadType: 'openai',
      scope: 'openai',
      statusCode: 429,
      error: { rawBody: 'RESOURCE_EXHAUSTED' },
      message: basePayload.error.message,
      type: basePayload.error.type,
      code: basePayload.error.code
    });
    assert.strictEqual(result.error.message, 'first');

    // case 4: gemini payload should keep upstream status and allow type/status based matching
    config.errorRewrite = {
      enabled: true,
      rules: [
        {
          id: 'rule-gemini-invalid-arg',
          enabled: true,
          logic: 'and',
          scope: ['gemini'],
          match: {
            statusCodes: [400],
            typeExact: ['INVALID_ARGUMENT'],
            codeExact: ['400'],
            messageExact: [],
            messageContains: ['temperature: range: 0..1'],
            rawExact: [],
            rawContains: []
          },
          rewrite: {
            mode: 'replace',
            message: '请将温度设置在0-1'
          }
        }
      ]
    };
    const geminiRaw = '{"error":{"code":400,"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"temperature: range: 0..1\\"},\\"request_id\\":\\"req_demo\\"}","status":"INVALID_ARGUMENT"}}';
    const geminiError = createApiError(`API请求失败 (400): ${geminiRaw}`, 400, geminiRaw);
    const geminiPayload = buildGeminiErrorPayload(geminiError, 400, { scope: 'gemini' });
    assert.strictEqual(geminiPayload.error.status, 'INVALID_ARGUMENT');
    assert.strictEqual(geminiPayload.error.message, '请将温度设置在0-1');

    // case 5: openai payload should extract nested upstream type/message for matching
    config.errorRewrite = {
      enabled: true,
      rules: [
        {
          id: 'rule-openai-nested',
          enabled: true,
          logic: 'and',
          scope: ['openai'],
          match: {
            statusCodes: [400],
            typeExact: ['invalid_request_error'],
            codeExact: ['400'],
            messageExact: [],
            messageContains: ['temperature: range: 0..1'],
            rawExact: [],
            rawContains: []
          },
          rewrite: {
            mode: 'replace',
            message: 'temperature 参数必须在 0 到 1 之间'
          }
        }
      ]
    };
    const openaiPayload = buildOpenAIErrorPayload(geminiError, 400, { scope: 'openai' });
    assert.strictEqual(openaiPayload.error.type, 'invalid_request_error');
    assert.strictEqual(openaiPayload.error.message, 'temperature 参数必须在 0 到 1 之间');

    console.log('✅ error rewrite tests passed');
  } finally {
    config.errorRewrite = originalPolicy;
  }
}

run();

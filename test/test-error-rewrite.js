import assert from 'assert';
import config from '../src/config/config.js';
import { rewriteErrorPayloadMessage } from '../src/utils/errorRewrite.js';

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

    console.log('✅ error rewrite tests passed');
  } finally {
    config.errorRewrite = originalPolicy;
  }
}

run();

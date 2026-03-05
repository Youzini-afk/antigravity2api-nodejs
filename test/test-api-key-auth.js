import assert from 'assert';
import { extractApiKeyCandidates, resolveApiKeyAuth } from '../src/server/api_key_auth.js';

function run() {
  // v1 路径：允许任一来源命中，invalid bearer 不应覆盖 valid x-api-key
  let result = resolveApiKeyAuth({
    pathname: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer invalid-key',
      'x-api-key': 'sk-primary'
    },
    query: {},
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-bypass-1']
  });
  assert.strictEqual(result.authRequired, true);
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'primary');
  assert.strictEqual(result.isBypassThreshold, false);

  // v1beta 路径：优先 query/key 与 x-goog-api-key（同时兼容其他来源）
  result = resolveApiKeyAuth({
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent',
    headers: {
      authorization: 'Bearer wrong',
      'x-goog-api-key': 'sk-bypass-2'
    },
    query: { key: 'sk-bypass-2' },
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-bypass-1', 'sk-bypass-2']
  });
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'bypass');
  assert.strictEqual(result.isBypassThreshold, true);

  // /cli/v1beta 也必须支持
  result = resolveApiKeyAuth({
    pathname: '/cli/v1beta/models/gemini-2.5-pro:generateContent',
    headers: { 'x-goog-api-key': 'sk-bypass-1' },
    query: {},
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-bypass-1']
  });
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'bypass');

  // 同一请求同时携带 primary 与 bypass（不同 key）：
  // 应按候选顺序选择首个命中的有效 key（v1 下 Authorization 优先）
  result = resolveApiKeyAuth({
    pathname: '/v1/chat/completions',
    headers: {
      authorization: 'Bearer sk-bypass-1',
      'x-api-key': 'sk-primary'
    },
    query: {},
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-bypass-1']
  });
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'bypass');
  assert.strictEqual(result.isBypassThreshold, true);

  // v1beta 下 query/key 优先于 header
  result = resolveApiKeyAuth({
    pathname: '/v1beta/models/gemini-2.5-pro:generateContent',
    headers: {
      authorization: 'Bearer sk-primary'
    },
    query: { key: 'sk-bypass-1' },
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-bypass-1']
  });
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'bypass');
  assert.strictEqual(result.isBypassThreshold, true);

  // 同一 key 同时出现在 primary 与 bypass：按 primary 语义处理
  result = resolveApiKeyAuth({
    pathname: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-primary' },
    query: {},
    primaryApiKey: 'sk-primary',
    bypassApiKeys: ['sk-primary', 'sk-bypass-1']
  });
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, 'primary');
  assert.strictEqual(result.isBypassThreshold, false);

  // 未配置任何 key：不要求鉴权
  result = resolveApiKeyAuth({
    pathname: '/v1/chat/completions',
    headers: {},
    query: {},
    primaryApiKey: '',
    bypassApiKeys: []
  });
  assert.strictEqual(result.authRequired, false);
  assert.strictEqual(result.isAuthenticated, true);
  assert.strictEqual(result.keyType, null);

  // 候选提取去重/trim 校验
  const candidates = extractApiKeyCandidates(
    '/v1/chat/completions',
    {
      authorization: 'Bearer sk-primary ',
      'x-api-key': ' sk-primary',
      'x-goog-api-key': 'sk-bypass-1'
    },
    { key: 'sk-bypass-1' }
  );
  assert.deepStrictEqual(candidates, ['sk-primary', 'sk-bypass-1']);

  console.log('✅ api key auth tests passed');
}

run();

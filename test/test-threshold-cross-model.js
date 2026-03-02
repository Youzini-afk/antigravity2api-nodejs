import assert from 'assert';
import tokenManager from '../src/auth/token_manager.js';
import quotaManager from '../src/auth/quota_manager.js';

async function run() {
  const token = { refresh_token: 'test-refresh-token' };
  const tokenId = '__threshold_test_token__';

  const originalPolicy = tokenManager.thresholdPolicy;
  const originalGetTokenIdAsync = tokenManager._getTokenIdAsync;
  const originalEnsureQuotaForThreshold = tokenManager._ensureQuotaForThreshold;

  try {
    tokenManager._getTokenIdAsync = async () => tokenId;
    tokenManager._ensureQuotaForThreshold = async () => {};
    tokenManager.thresholdPolicy = {
      enabled: true,
      modelGroupPercent: 20,
      globalPercent: 20,
      crossModelGlobalBlock: false,
      applyStrategies: {
        round_robin: true,
        request_count: true,
        quota_exhausted: true
      },
      allBelowThresholdAction: 'strict'
    };

    // Case 1: 目标模型组额度高，其他模型组额度低；关闭跨模型阻断时应放行
    quotaManager.cache.set(tokenId, {
      lastUpdated: Date.now(),
      models: {
        'gemini-2.5-pro': { r: 0.6 },
        'claude-3.5-sonnet': { r: 0.1 }
      },
      requestCounts: {},
      resetTimes: {}
    });
    let result = await tokenManager._evaluateThreshold(token, 'gemini-2.5-pro');
    assert.strictEqual(result.pass, true, 'crossModelGlobalBlock=false 时不应被其他模型组额度阻断');

    // Case 2: 同一数据下开启跨模型阻断，应因全局最小额度被阻断
    tokenManager.thresholdPolicy.crossModelGlobalBlock = true;
    result = await tokenManager._evaluateThreshold(token, 'gemini-2.5-pro');
    assert.strictEqual(result.pass, false, 'crossModelGlobalBlock=true 时应触发全局阻断');
    assert.strictEqual(result.reason, 'global', '开启跨模型阻断时应返回 global 原因');

    // Case 3: 目标模型组本身低于阈值，关闭跨模型阻断也应被阻断
    tokenManager.thresholdPolicy.crossModelGlobalBlock = false;
    quotaManager.cache.set(tokenId, {
      lastUpdated: Date.now(),
      models: {
        'gemini-2.5-pro': { r: 0.1 },
        'claude-3.5-sonnet': { r: 0.9 }
      },
      requestCounts: {},
      resetTimes: {}
    });
    result = await tokenManager._evaluateThreshold(token, 'gemini-2.5-pro');
    assert.strictEqual(result.pass, false, '目标模型组额度低于阈值时应被阻断');
    assert.strictEqual(result.reason, 'group', '目标模型组被阻断时应返回 group 原因');

    console.log('✅ threshold cross-model regression tests passed');
  } finally {
    tokenManager.thresholdPolicy = originalPolicy;
    tokenManager._getTokenIdAsync = originalGetTokenIdAsync;
    tokenManager._ensureQuotaForThreshold = originalEnsureQuotaForThreshold;
    quotaManager.cache.delete(tokenId);
  }
}

run().catch((error) => {
  console.error('❌ threshold cross-model regression tests failed');
  console.error(error);
  process.exit(1);
});

import assert from 'assert';
import geminicliTokenManager from '../src/auth/geminicli_token_manager.js';

async function run() {
  const manager = geminicliTokenManager;
  const originals = {
    ensureInitialized: manager._ensureInitialized,
    prepareToken: manager._prepareToken,
    canUseTokenForModel: manager._canUseTokenForModel,
    checkThresholdAndCollectFallback: manager._checkThresholdAndCollectFallback,
    tokens: manager.tokens,
    currentIndex: manager.currentIndex,
    rotationStrategy: manager.rotationStrategy,
    thresholdPolicy: manager.thresholdPolicy,
    tokenRequestCounts: manager.tokenRequestCounts
  };

  try {
    manager._ensureInitialized = async () => {};
    manager._prepareToken = async () => 'ready';
    manager.rotationStrategy = 'round_robin';
    manager.currentIndex = 0;
    manager.tokenRequestCounts = new Map();
    manager.thresholdPolicy = {
      enabled: true,
      modelGroupPercent: 20,
      globalPercent: 20,
      applyStrategies: { round_robin: true, request_count: true, quota_exhausted: true },
      allBelowThresholdAction: 'strict'
    };

    // 用例1：先做非阈值门禁（冷却/额度），不可用 token 不应进入阈值检查
    const tokenA = { refresh_token: 'a', useThreshold: true, allowBypassWithSpecialKey: true };
    const tokenB = { refresh_token: 'b', useThreshold: true, allowBypassWithSpecialKey: true };
    manager.tokens = [tokenA, tokenB];

    const checked = [];
    manager._canUseTokenForModel = (token) => token.refresh_token !== 'a';
    manager._checkThresholdAndCollectFallback = async (token) => {
      checked.push(token.refresh_token);
      return true;
    };

    let selected = await manager.getToken('gemini-2.5-pro', { bypassThreshold: false });
    assert.strictEqual(selected?.refresh_token, 'b');
    assert.deepStrictEqual(checked, ['b']);

    // 用例2：特殊 key 仅在凭证允许时绕过阈值
    const tokenC = { refresh_token: 'c', useThreshold: true, allowBypassWithSpecialKey: false };
    const tokenD = { refresh_token: 'd', useThreshold: true, allowBypassWithSpecialKey: true };
    manager.tokens = [tokenC, tokenD];
    manager.currentIndex = 0;
    manager._canUseTokenForModel = () => true;
    manager._checkThresholdAndCollectFallback = async (token) => token.refresh_token !== 'c';

    selected = await manager.getToken('gemini-2.5-pro', { bypassThreshold: true });
    assert.strictEqual(selected?.refresh_token, 'd');

    // 用例3：凭证关闭阈值时，无论普通/特殊 key 都不走阈值过滤
    const tokenE = { refresh_token: 'e', useThreshold: false, allowBypassWithSpecialKey: false };
    manager.tokens = [tokenE];
    manager.currentIndex = 0;
    let thresholdCalled = false;
    manager._checkThresholdAndCollectFallback = async () => {
      thresholdCalled = true;
      return false;
    };

    selected = await manager.getToken('gemini-2.5-pro', { bypassThreshold: false });
    assert.strictEqual(selected?.refresh_token, 'e');
    assert.strictEqual(thresholdCalled, false);

    console.log('✅ geminicli token selection tests passed');
  } finally {
    manager._ensureInitialized = originals.ensureInitialized;
    manager._prepareToken = originals.prepareToken;
    manager._canUseTokenForModel = originals.canUseTokenForModel;
    manager._checkThresholdAndCollectFallback = originals.checkThresholdAndCollectFallback;
    manager.tokens = originals.tokens;
    manager.currentIndex = originals.currentIndex;
    manager.rotationStrategy = originals.rotationStrategy;
    manager.thresholdPolicy = originals.thresholdPolicy;
    manager.tokenRequestCounts = originals.tokenRequestCounts;
  }
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});

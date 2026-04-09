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
    tokenRequestCounts: manager.tokenRequestCounts,
    getTokenId: manager.getTokenId
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

    // 用例4：pending token 不参与正常轮换，preview 模型优先 supported
    const tokenPending = { refresh_token: 'pending', status: 'pending', enable: true, previewCapability: 'unknown', tier: 'pro' };
    const tokenUnsupported = { refresh_token: 'unsupported', status: 'ready', enable: true, previewCapability: 'unsupported', tier: 'pro' };
    const tokenUnknown = { refresh_token: 'unknown', status: 'ready', enable: true, previewCapability: 'unknown', tier: 'pro' };
    const tokenSupported = { refresh_token: 'supported', status: 'ready', enable: true, previewCapability: 'supported', tier: 'pro' };
    manager.tokens = [tokenPending, tokenUnsupported, tokenUnknown, tokenSupported];
    manager.currentIndex = 0;
    manager.thresholdPolicy = { enabled: false, applyStrategies: { round_robin: false, request_count: false, quota_exhausted: false } };
    manager._prepareToken = async (token) => token.status === 'ready' ? 'ready' : 'skip';
    manager._canUseTokenForModel = (token) => token.status === 'ready';

    selected = await manager.getToken('gemini-3-flash-preview', { bypassThreshold: false });
    assert.strictEqual(selected?.refresh_token, 'supported');

    // 用例5：非 preview 模型优先 unsupported，避免过度占用 supported 凭证
    manager.currentIndex = 0;
    selected = await manager.getToken('gemini-2.5-flash', { bypassThreshold: false });
    assert.strictEqual(selected?.refresh_token, 'unsupported');

    // 用例6：excludeTokenIds 应能在重试切换时排除当前凭证
    manager.currentIndex = 0;
    manager.getTokenId = (token) => token.refresh_token;
    selected = await manager.getToken('gemini-3-flash-preview', {
      bypassThreshold: false,
      excludeTokenIds: ['supported']
    });
    assert.strictEqual(selected?.refresh_token, 'unknown');

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
    manager.getTokenId = originals.getTokenId;
  }
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});

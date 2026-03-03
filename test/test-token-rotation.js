import tokenManager from '../src/auth/token_manager.js';

async function testTokenRotation() {
  console.log('=== 开始测试 Token 轮询 ===\n');

  const tokenList = await tokenManager.getTokenList();
  const expectedTokenCount = tokenList.length;
  if (expectedTokenCount === 0) {
    console.warn('SKIP: 当前无可用账号，跳过轮询测试');
    process.exit(0);
  }

  const totalTests = 10;
  const usedTokens = new Map();

  console.log(`初始状态: ${expectedTokenCount} 个可用账号\n`);

  for (let i = 1; i <= totalTests; i++) {
    console.log(`--- 第 ${i} 次请求 ---`);

    const token = await tokenManager.getToken();

    if (!token) {
      console.error('FAIL: 轮询过程中出现无可用 token');
      process.exit(1);
    }

    const tokenId = token.refresh_token.slice(-8);
    console.log(`✓ 获取到 token: ...${tokenId}`);
    console.log(`  当前索引: ${tokenManager.currentIndex}`);
    console.log(`  剩余账号: ${tokenManager.tokens.length}\n`);

    usedTokens.set(tokenId, (usedTokens.get(tokenId) || 0) + 1);
  }

  console.log('=== 轮询统计 ===');
  console.log(`总请求次数: ${totalTests}`);
  console.log(`使用的不同账号数: ${usedTokens.size}`);
  console.log('\n各账号使用次数:');
  usedTokens.forEach((count, tokenId) => {
    console.log(`  ...${tokenId}: ${count} 次`);
  });

  if (usedTokens.size === expectedTokenCount) {
    console.log('\n✅ 所有账号都被正确轮换使用');
  } else {
    console.error(`\nFAIL: 轮询覆盖不足，期望 ${expectedTokenCount} 个账号，实际覆盖 ${usedTokens.size} 个`);
    process.exit(1);
  }
}

testTokenRotation().catch((error) => {
  console.error(error);
  process.exit(1);
});

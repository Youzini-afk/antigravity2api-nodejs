/**
 * Token轮询功能测试脚本
 * 测试三种轮询策略：round_robin, quota_exhausted, request_count
 */

import path from 'path';
import { fileURLToPath } from 'url';
import TokenStore from '../src/auth/token_store.js';
import TokenPool from '../src/auth/token_pool.js';
import { StrategyFactory } from '../src/auth/token_rotation_strategy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 使用mock文件路径
const mockAccountsPath = path.join(__dirname, 'mock-accounts.json');

// 测试结果统计
let passed = 0;
let failed = 0;

// 辅助函数：打印测试结果
function printResult(testName, success, message = '') {
  if (success) {
    console.log(`✅ ${testName}`);
    passed++;
  } else {
    console.log(`❌ ${testName}${message ? ': ' + message : ''}`);
    failed++;
  }
}

// 辅助函数：延迟
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('\n=== Token轮询功能测试 ===\n');

async function testRoundRobinStrategy() {
  console.log('📋 测试1: Round Robin 策略');
  console.log('预期: 依次轮询每个可用token\n');

  try {
    // 初始化
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');

    // 加载tokens
    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);

    printResult('加载测试数据', enabledTokens.length === 3, `获取到${enabledTokens.length}个启用的token`);

    // 添加到pool
    for (const token of enabledTokens) {
      await pool.add(token);
    }

    // 获取可用tokens（构建轮询策略需要的格式）
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('Token池初始化', availableTokens.length === 3);

    // 测试轮询顺序
    const selectedTokens = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.selectToken(availableTokens);
      if (selected) {
        selectedTokens.push(selected.token.name);
        strategy.recordUsage(selected.tokenId);
      }
    }

    console.log(`  轮询顺序: ${selectedTokens.join(' -> ')}`);

    // 验证轮询是循环的
    const expectedPattern = ['测试账号1', '测试账号2', '测试账号3', '测试账号1', '测试账号2', '测试账号3'];
    const isCorrectPattern = selectedTokens.every((name, idx) => name === expectedPattern[idx]);

    printResult('Round Robin轮询顺序', isCorrectPattern);

    // 测试重置
    strategy.reset();
    const firstAfterReset = strategy.selectToken(availableTokens);
    printResult('策略重置', firstAfterReset.token.name === '测试账号1');

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

async function testQuotaExhaustedStrategy() {
  console.log('📋 测试2: Quota Exhausted 策略');
  console.log('预期: 持续使用同一个token直到手动切换\n');

  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('quota_exhausted');

    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);

    for (const token of enabledTokens) {
      await pool.add(token);
    }

    // 获取可用tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));

    // 多次获取token，应该都是同一个
    const selectedTokens = [];
    for (let i = 0; i < 5; i++) {
      const selected = strategy.selectToken(availableTokens);
      selectedTokens.push(selected.token.name);
    }

    console.log(`  使用顺序: ${selectedTokens.join(' -> ')}`);

    // 验证都是同一个token
    const allSame = selectedTokens.every(name => name === selectedTokens[0]);
    printResult('持续使用同一token', allSame);

    // 手动切换到下一个
    strategy.switchToNext(availableTokens.length);
    const afterSwitch = strategy.selectToken(availableTokens);

    printResult('手动切换token', afterSwitch.token.name === '测试账号2');

    // 再次手动切换
    strategy.switchToNext(availableTokens.length);
    const afterSecondSwitch = strategy.selectToken(availableTokens);

    printResult('第二次切换', afterSecondSwitch.token.name === '测试账号3');

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

async function testRequestCountStrategy() {
  console.log('📋 测试3: Request Count 策略');
  console.log('预期: 每个token处理固定次数请求后自动切换\n');

  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const requestsPerToken = 3; // 每个token处理3次请求
    const strategy = StrategyFactory.create('request_count', { requestCountPerToken: requestsPerToken });

    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);

    for (const token of enabledTokens) {
      await pool.add(token);
    }

    // 获取可用tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));

    // 模拟请求并记录使用
    const selectedTokens = [];
    let currentTokenId = null;

    for (let i = 0; i < 9; i++) {
      const selected = strategy.selectToken(availableTokens);
      selectedTokens.push(selected.token.name);

      // 记录使用
      const shouldSwitch = strategy.recordUsage(selected.tokenId);

      if (shouldSwitch) {
        console.log(`  第${i + 1}次请求后触发切换 (${selected.token.name}已达到${requestsPerToken}次)`);
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }

      currentTokenId = selected.tokenId;
    }

    console.log(`  使用顺序: ${selectedTokens.join(' -> ')}`);

    // 验证切换模式：每3次切换一个token
    const expectedPattern = [
      '测试账号1', '测试账号1', '测试账号1',
      '测试账号2', '测试账号2', '测试账号2',
      '测试账号3', '测试账号3', '测试账号3'
    ];

    const isCorrectPattern = selectedTokens.every((name, idx) => name === expectedPattern[idx]);
    printResult('按请求次数切换', isCorrectPattern);

    // 测试修改阈值
    strategy.setRequestCountPerToken(2);
    strategy.reset();

    const newPattern = [];
    for (let i = 0; i < 6; i++) {
      const selected = strategy.selectToken(availableTokens);
      newPattern.push(selected.token.name);

      const shouldSwitch = strategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }
    }

    console.log(`  新阈值(2次)顺序: ${newPattern.join(' -> ')}`);

    const newExpected = [
      '测试账号1', '测试账号1',
      '测试账号2', '测试账号2',
      '测试账号3', '测试账号3'
    ];

    const isNewPatternCorrect = newPattern.every((name, idx) => name === newExpected[idx]);
    printResult('修改阈值后切换', isNewPatternCorrect);

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

async function testTokenPoolIntegration() {
  console.log('📋 测试4: TokenPool与轮询策略集成');
  console.log('预期: 验证token禁用后轮询自动跳过\n');

  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');

    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);

    // 添加所有启用的tokens
    const tokenIds = [];
    for (const token of enabledTokens) {
      const tokenId = await pool.add(token);
      tokenIds.push(tokenId);
    }

    printResult('初始token数量', pool.size() === 3);

    // 禁用一个token
    pool.disable(tokenIds[1]); // 禁用第二个token

    // 获取可用tokens
    const enabledIdsAfterDisable = pool.getEnabledIds();
    const availableAfterDisable = enabledIdsAfterDisable.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('禁用token后可用数量', availableAfterDisable.length === 2);

    // 测试轮询是否跳过禁用的token
    const selectedAfterDisable = [];
    for (let i = 0; i < 4; i++) {
      const selected = strategy.selectToken(availableAfterDisable);
      selectedAfterDisable.push(selected.token.name);
    }

    console.log(`  禁用账号2后轮询: ${selectedAfterDisable.join(' -> ')}`);

    // 验证没有选中被禁用的token
    const noDisabledToken = !selectedAfterDisable.includes('测试账号2');
    printResult('跳过禁用token', noDisabledToken);

    // 重新启用
    pool.enable(tokenIds[1]);
    const enabledIdsAfterEnable = pool.getEnabledIds();
    const availableAfterEnable = enabledIdsAfterEnable.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));
    printResult('重新启用token', availableAfterEnable.length === 3);

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

async function testStrategySwitch() {
  console.log('📋 测试5: 动态切换轮询策略');
  console.log('预期: 验证运行时切换策略的功能\n');

  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);

    const tokens = await store.readAll();
    const enabledTokens = tokens.filter(t => !t.disabled);

    for (const token of enabledTokens) {
      await pool.add(token);
    }

    // 获取可用tokens
    const enabledIds = pool.getEnabledIds();
    const availableTokens = enabledIds.map(id => ({
      tokenId: id,
      token: pool.get(id)
    }));

    // 测试从round_robin切换到quota_exhausted
    let strategy = StrategyFactory.create('round_robin');

    const roundRobinResults = [];
    for (let i = 0; i < 3; i++) {
      const selected = strategy.selectToken(availableTokens);
      roundRobinResults.push(selected.token.name);
    }

    console.log(`  Round Robin: ${roundRobinResults.join(' -> ')}`);
    printResult('Round Robin模式', roundRobinResults.length === 3);

    // 切换策略
    strategy = StrategyFactory.create('quota_exhausted');

    const quotaResults = [];
    for (let i = 0; i < 3; i++) {
      const selected = strategy.selectToken(availableTokens);
      quotaResults.push(selected.token.name);
    }

    console.log(`  Quota Exhausted: ${quotaResults.join(' -> ')}`);

    const allSame = quotaResults.every(name => name === quotaResults[0]);
    printResult('切换到Quota Exhausted', allSame);

    // 切换到request_count
    strategy = StrategyFactory.create('request_count', { requestCountPerToken: 2 });

    const requestCountResults = [];
    for (let i = 0; i < 4; i++) {
      const selected = strategy.selectToken(availableTokens);
      requestCountResults.push(selected.token.name);

      const shouldSwitch = strategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        strategy.switchToNext(availableTokens.length, selected.tokenId);
      }
    }

    console.log(`  Request Count: ${requestCountResults.join(' -> ')}`);
    printResult('切换到Request Count', requestCountResults.length === 4);

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

async function testEdgeCases() {
  console.log('📋 测试6: 边界情况处理');
  console.log('预期: 正确处理空token池、单token等情况\n');

  try {
    const store = new TokenStore(mockAccountsPath);
    const pool = new TokenPool(store);
    const strategy = StrategyFactory.create('round_robin');

    // 测试空token池
    const emptyResult = strategy.selectToken([]);
    printResult('空token池返回null', emptyResult === null);

    // 测试单个token
    const singleToken = {
      tokenId: 'single_id',
      token: { name: '单一账号', refresh_token: 'single_token' }
    };

    const singleResults = [];
    for (let i = 0; i < 3; i++) {
      const result = strategy.selectToken([singleToken]);
      singleResults.push(result.token.name);
    }

    const allSingle = singleResults.every(name => name === '单一账号');
    printResult('单token循环', allSingle);

    // 测试request_count策略的边界
    const rcStrategy = StrategyFactory.create('request_count', { requestCountPerToken: 1 });

    const token1 = { tokenId: 'id1', token: { name: 'Token1', refresh_token: 't1' } };
    const token2 = { tokenId: 'id2', token: { name: 'Token2', refresh_token: 't2' } };

    const rcResults = [];
    for (let i = 0; i < 4; i++) {
      const selected = rcStrategy.selectToken([token1, token2]);
      rcResults.push(selected.token.name);

      const shouldSwitch = rcStrategy.recordUsage(selected.tokenId);
      if (shouldSwitch) {
        rcStrategy.switchToNext(2, selected.tokenId);
      }
    }

    console.log(`  阈值=1时切换: ${rcResults.join(' -> ')}`);

    const expectedRc = ['Token1', 'Token2', 'Token1', 'Token2'];
    const isRcCorrect = rcResults.every((name, idx) => name === expectedRc[idx]);
    printResult('阈值=1时每次切换', isRcCorrect);

    console.log();
  } catch (error) {
    console.error('测试失败:', error.message);
    failed++;
  }
}

// 运行所有测试
async function runAllTests() {
  try {
    await testRoundRobinStrategy();
    await testQuotaExhaustedStrategy();
    await testRequestCountStrategy();
    await testTokenPoolIntegration();
    await testStrategySwitch();
    await testEdgeCases();

    // 打印总结
    console.log('\n=== 测试总结 ===');
    console.log(`✅ 通过: ${passed}`);
    console.log(`❌ 失败: ${failed}`);
    console.log(`📊 总计: ${passed + failed}`);

    if (failed === 0) {
      console.log('\n🎉 所有测试通过！Token轮询功能正常工作。\n');
    } else {
      console.log('\n⚠️  部分测试失败，请检查相关功能。\n');
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ 测试执行出错:', error);
    process.exit(1);
  }
}

// 执行测试
runAllTests();

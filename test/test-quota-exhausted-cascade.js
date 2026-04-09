/**
 * 配额耗尽级联管理集成测试
 * 测试当 token 的所有模型组都被禁用时，自动标记 token 为配额耗尽状态
 */

import { hasOtherAvailableModelGroups, getAvailableModelGroups } from '../src/utils/tokenQuotaHelper.js';
import tokenCooldownManager from '../src/auth/token_cooldown_manager.js';

// 测试用的 token ID
const TEST_TOKEN_ID = 'test-token-cascade';

// 核心模型（用于测试）
const TEST_MODELS = {
  claude: 'claude-3-5-sonnet-20241022',
  gemini: 'gemini-2.0-flash-exp',
  banana: 'imagen-3.0-generate-001'
};

/**
 * 测试辅助函数：清理测试 token 的冷却状态
 */
function cleanupTestToken() {
  for (const modelId of Object.values(TEST_MODELS)) {
    tokenCooldownManager.clearCooldown(TEST_TOKEN_ID, modelId);
  }
}

/**
 * 测试 1: 验证初始状态 - 所有模型组都可用
 */
function test1_initialState() {
  console.log('\n=== 测试 1: 初始状态检查 ===');
  cleanupTestToken();

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 初始状态 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (!hasOther || available.length !== 3) {
    throw new Error('初始状态错误：应该所有模型组都可用');
  }

  console.log('✅ 测试 1 通过');
}

/**
 * 测试 2: 禁用单个模型组 - 仍有其他可用
 */
function test2_singleGroupDisabled() {
  console.log('\n=== 测试 2: 禁用单个模型组 ===');
  cleanupTestToken();

  // 禁用 Claude 模型组
  const resetTime = Date.now() + 3600000; // 1小时后恢复
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 禁用 claude 后 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (!hasOther) {
    throw new Error('禁用单个模型组后应该还有其他可用模型组');
  }

  if (available.length !== 2 || !available.includes('gemini') || !available.includes('banana')) {
    throw new Error('可用模型组列表错误');
  }

  console.log('✅ 测试 2 通过');
}

/**
 * 测试 3: 禁用两个模型组 - 仍有一个可用
 */
function test3_twoGroupsDisabled() {
  console.log('\n=== 测试 3: 禁用两个模型组 ===');
  cleanupTestToken();

  const resetTime = Date.now() + 3600000;

  // 禁用 Claude 和 Gemini
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, resetTime);

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 禁用 claude, gemini 后 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (!hasOther) {
    throw new Error('禁用两个模型组后应该还有一个可用模型组');
  }

  if (available.length !== 1 || !available.includes('banana')) {
    throw new Error('可用模型组列表错误');
  }

  console.log('✅ 测试 3 通过');
}

/**
 * 测试 4: 禁用所有模型组 - 无可用模型组
 */
function test4_allGroupsDisabled() {
  console.log('\n=== 测试 4: 禁用所有模型组 ===');
  cleanupTestToken();

  const resetTime = Date.now() + 3600000;

  // 禁用所有模型组
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, resetTime);
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.banana, resetTime);

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 禁用所有模型组后 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (hasOther) {
    throw new Error('禁用所有模型组后应该没有可用模型组');
  }

  if (available.length !== 0) {
    throw new Error('可用模型组列表应该为空');
  }

  console.log('✅ 测试 4 通过');
}

/**
 * 测试 5: 冷却时间过期后自动恢复
 */
function test5_cooldownExpiry() {
  console.log('\n=== 测试 5: 冷却时间过期后自动恢复 ===');
  cleanupTestToken();

  // 设置一个已过期的冷却时间
  const expiredTime = Date.now() - 1000; // 1秒前
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, expiredTime);

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 冷却过期后 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (!hasOther || available.length !== 3) {
    throw new Error('冷却过期后应该恢复可用');
  }

  console.log('✅ 测试 5 通过');
}

/**
 * 测试 6: 混合状态 - 部分过期，部分未过期
 */
function test6_mixedState() {
  console.log('\n=== 测试 6: 混合冷却状态 ===');
  cleanupTestToken();

  const expiredTime = Date.now() - 1000;
  const futureTime = Date.now() + 3600000;

  // Claude 已过期（应该可用）
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.claude, expiredTime);
  // Gemini 未过期（不可用）
  tokenCooldownManager.setCooldown(TEST_TOKEN_ID, TEST_MODELS.gemini, futureTime);
  // Banana 未设置冷却（可用）

  const hasOther = hasOtherAvailableModelGroups(TEST_TOKEN_ID);
  const available = getAvailableModelGroups(TEST_TOKEN_ID);

  console.log(`✓ 混合状态 - 有其他可用模型组: ${hasOther}`);
  console.log(`✓ 可用模型组列表: [${available.join(', ')}]`);

  if (!hasOther) {
    throw new Error('混合状态下应该有可用模型组');
  }

  if (available.length !== 2 || !available.includes('claude') || !available.includes('banana')) {
    throw new Error('可用模型组列表错误，应该包含 claude 和 banana');
  }

  console.log('✅ 测试 6 通过');
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始配额耗尽级联管理集成测试\n');
  console.log('测试目标：验证当 token 的所有模型组都被禁用时的处理逻辑');

  try {
    test1_initialState();
    test2_singleGroupDisabled();
    test3_twoGroupsDisabled();
    test4_allGroupsDisabled();
    test5_cooldownExpiry();
    test6_mixedState();

    console.log('\n✅ 所有测试通过！');
    console.log('\n测试总结：');
    console.log('1. ✅ 初始状态检查正常');
    console.log('2. ✅ 单个模型组禁用后仍有其他可用');
    console.log('3. ✅ 两个模型组禁用后仍有一个可用');
    console.log('4. ✅ 所有模型组禁用后无可用（触发配额耗尽）');
    console.log('5. ✅ 冷却过期后自动恢复');
    console.log('6. ✅ 混合状态处理正确');

    // 清理
    cleanupTestToken();

    process.exit(0);
  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    console.error(error.stack);

    // 清理
    cleanupTestToken();

    process.exit(1);
  }
}

// 运行测试
runAllTests();

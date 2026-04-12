/**
 * 测试积分信息提取功能
 * 验证从 loadCodeAssist 接口正确提取和保存积分信息
 */

// 模拟 loadCodeAssist API 响应数据
const mockLoadCodeAssistResponse = {
  currentTier: {
    id: 'g1-pro-tier'
  },
  cloudaicompanionProject: 'test-project-123',
  paidTier: {
    availableCredits: [
      {
        creditAmount: '150.50'
      }
    ]
  }
};

// 模拟 free-tier 响应（无积分信息）
const mockFreeTierResponse = {
  currentTier: {
    id: 'free-tier'
  },
  cloudaicompanionProject: 'test-project-456'
};

// 模拟未激活账号响应
const mockUnactivatedResponse = {
  allowedTiers: [
    {
      id: 'LEGACY',
      isDefault: true
    }
  ]
};

/**
 * 测试积分提取逻辑
 */
function testCreditsExtraction() {
  console.log('=== 测试积分信息提取 ===\n');

  // 测试 1: Pro 账号有积分
  console.log('测试 1: Pro 账号有积分');
  const data1 = mockLoadCodeAssistResponse;
  const sub1 = data1.currentTier.id;
  let credits1 = null;
  
  if (sub1 !== 'free-tier' && data1?.paidTier?.availableCredits?.[0]?.creditAmount) {
    try {
      credits1 = parseFloat(data1.paidTier.availableCredits[0].creditAmount);
      console.log(`✓ 成功提取积分: ${credits1}`);
      console.log(`✓ 订阅类型: ${sub1}`);
    } catch (err) {
      console.log(`✗ 解析失败: ${err.message}`);
    }
  } else {
    console.log(`- 无积分信息 (sub=${sub1})`);
  }
  console.log('');

  // 测试 2: Free-tier 账号无积分
  console.log('测试 2: Free-tier 账号无积分');
  const data2 = mockFreeTierResponse;
  const sub2 = data2.currentTier.id;
  let credits2 = null;
  
  if (sub2 !== 'free-tier' && data2?.paidTier?.availableCredits?.[0]?.creditAmount) {
    try {
      credits2 = parseFloat(data2.paidTier.availableCredits[0].creditAmount);
      console.log(`✓ 成功提取积分: ${credits2}`);
    } catch (err) {
      console.log(`✗ 解析失败: ${err.message}`);
    }
  } else {
    console.log(`✓ 正确跳过 (sub=${sub2}, credits=null)`);
  }
  console.log('');

  // 测试 3: 未激活账号
  console.log('测试 3: 未激活账号');
  const data3 = mockUnactivatedResponse;
  if (!data3.currentTier) {
    console.log(`✓ 正确识别为未激活账号`);
  }
  console.log('');

  // 测试 4: 边界情况 - 字符串转浮点数
  console.log('测试 4: 字符串转浮点数');
  const testValues = ['150.50', '100', '0.99', '1000.123456'];
  testValues.forEach(value => {
    const parsed = parseFloat(value);
    console.log(`  "${value}" -> ${parsed}`);
  });
  console.log('');

  console.log('=== 所有测试完成 ===');
}

// 运行测试
testCreditsExtraction();
import { generateRequestBody } from '../src/utils/utils.js';

// 测试场景：user -> assistant -> assistant(工具调用,无content) -> tool1结果 -> tool2结果
const testMessages = [
  {
    role: "user",
    content: "帮我查询天气和新闻"
  },
  {
    role: "assistant",
    content: "好的，我来帮你查询。"
  },
  {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_001",
        type: "function",
        function: {
          name: "get_weather",
          arguments: JSON.stringify({ city: "北京" })
        }
      },
      {
        id: "call_002",
        type: "function",
        function: {
          name: "get_news",
          arguments: JSON.stringify({ category: "科技" })
        }
      }
    ]
  },
  {
    role: "tool",
    tool_call_id: "call_001",
    content: "北京今天晴，温度25度"
  },
  {
    role: "tool",
    tool_call_id: "call_002",
    content: "最新科技新闻：AI技术突破"
  }
];

const testTools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "获取天气信息",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "获取新闻",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string" }
        }
      }
    }
  }
];

const mockToken = {
  sessionId: 'test-session-id',
  projectId: 'test-project-id'
};

console.log("=== 测试消息转换 ===\n");
console.log("输入 OpenAI 格式消息:");
console.log(JSON.stringify(testMessages, null, 2));

const result = generateRequestBody(testMessages, "claude-sonnet-4-5", {}, testTools, mockToken);
if (!result?.request?.contents || !Array.isArray(result.request.contents)) {
  console.error('FAIL: generateRequestBody 返回结构异常');
  process.exit(1);
}

console.log("\n=== 转换后的 Antigravity 格式 ===\n");
console.log(JSON.stringify(result.request.contents, null, 2));

console.log("\n=== 验证结果 ===");
const contents = result.request.contents;
const hasValidLength = contents.length >= 3;
const firstIsUser = contents[0]?.role === 'user';
const secondIsModel = contents[1]?.role === 'model';
const secondHasToolCalls = Array.isArray(contents[1]?.parts) &&
  contents[1].parts.some((part) => part?.functionCall);
const thirdHasFunctionResponses = contents[2]?.role === 'user' &&
  Array.isArray(contents[2]?.parts) &&
  contents[2].parts.some((part) => part?.functionResponse);

console.log(`✓ 消息数量(>=3): ${hasValidLength ? '✓' : '✗'} (当前 ${contents.length})`);
console.log(`✓ 第1条 (user): ${firstIsUser ? '✓' : '✗'}`);
console.log(`✓ 第2条 (model): ${secondIsModel ? '✓' : '✗'}`);
console.log(`✓ 第2条包含 tool calls: ${secondHasToolCalls ? '✓' : '✗'}`);
console.log(`✓ 第3条包含 function responses: ${thirdHasFunctionResponses ? '✓' : '✗'}`);

if (!(hasValidLength && firstIsUser && secondIsModel && secondHasToolCalls && thirdHasFunctionResponses)) {
  console.error('FAIL: 消息转换结果不符合预期');
  process.exit(1);
}

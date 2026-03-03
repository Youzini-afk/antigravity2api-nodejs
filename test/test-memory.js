/**
 * 内存优化效果测试脚本
 * 用于验证服务的内存使用是否控制在目标范围内（约20MB）
 */

import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置
const PORT = process.env.PORT || 9876;
const BASE_URL = `http://localhost:${PORT}`;
const TEST_DURATION_MS = 60000; // 测试持续时间：60秒
const SAMPLE_INTERVAL_MS = 2000; // 采样间隔：2秒
const REQUEST_INTERVAL_MS = 1000; // 请求间隔：1秒

// 内存采样数据
const memorySamples = [];
let serverProcess = null;
let testStartTime = null;

/**
 * 格式化内存大小
 */
function formatMemory(bytes) {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(2)} MB`;
}

/**
 * 发送HTTP请求
 */
function sendRequest(urlPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * 获取服务器内存使用情况（通过 /v1/memory 端点）
 */
async function getServerMemory() {
  try {
    const response = await sendRequest('/v1/memory');
    if (response.status === 200) {
      const data = JSON.parse(response.data);
      return data;
    }
  } catch (e) {
    // 如果端点不存在，返回 null
  }
  return null;
}

/**
 * 模拟API请求
 */
async function simulateLoad() {
  const requests = [
    { path: '/v1/models', method: 'GET' },
    { path: '/health', method: 'GET' },
    { path: '/v1/chat/completions', method: 'POST', body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'Hello, this is a test message for memory optimization.' }],
      stream: false
    }},
  ];

  const randomRequest = requests[Math.floor(Math.random() * requests.length)];
  try {
    await sendRequest(randomRequest.path, randomRequest.method, randomRequest.body);
  } catch (e) {
    // 忽略请求错误，重点是测试内存
  }
}

/**
 * 启动服务器进程
 */
function startServer() {
  return new Promise((resolve, reject) => {
    console.log('🚀 启动服务器...');
    
    const serverPath = path.join(__dirname, '..', 'src', 'server', 'index.js');
    serverProcess = spawn('node', ['--expose-gc', serverPath], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: PORT.toString() },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let started = false;
    
    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (!started && (output.includes('listening') || output.includes('Server started') || output.includes('服务器'))) {
        started = true;
        setTimeout(resolve, 1000); // 等待服务器完全就绪
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });

    serverProcess.on('error', reject);

    // 超时处理
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve(); // 即使没有检测到启动消息，也继续测试
      }
    }, 5000);
  });
}

/**
 * 停止服务器进程
 */
function stopServer() {
  if (serverProcess) {
    console.log('\n🛑 停止服务器...');
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
}

/**
 * 采集内存样本
 */
async function collectMemorySample() {
  const memoryInfo = await getServerMemory();
  const elapsed = Date.now() - testStartTime;
  
  if (memoryInfo) {
    memorySamples.push({
      time: elapsed,
      heapUsed: memoryInfo.heapUsed,
      heapTotal: memoryInfo.heapTotal,
      rss: memoryInfo.rss,
      external: memoryInfo.external
    });
    
    console.log(`📊 [${(elapsed/1000).toFixed(1)}s] Heap: ${formatMemory(memoryInfo.heapUsed)} / ${formatMemory(memoryInfo.heapTotal)}, RSS: ${formatMemory(memoryInfo.rss)}`);
  } else {
    // 如果没有内存端点，使用进程内存估算
    const usage = process.memoryUsage();
    console.log(`📊 [${(elapsed/1000).toFixed(1)}s] 测试进程内存 - Heap: ${formatMemory(usage.heapUsed)}, RSS: ${formatMemory(usage.rss)}`);
  }
}

/**
 * 分析内存数据
 */
function analyzeResults() {
  if (memorySamples.length === 0) {
    console.log('\n⚠️ 没有采集到内存数据（服务器可能没有 /v1/memory 端点）');
    console.log('请手动检查服务器日志中的内存使用情况。');
    return;
  }

  const heapValues = memorySamples.map(s => s.heapUsed);
  const rssValues = memorySamples.map(s => s.rss);

  const heapMin = Math.min(...heapValues);
  const heapMax = Math.max(...heapValues);
  const heapAvg = heapValues.reduce((a, b) => a + b, 0) / heapValues.length;

  const rssMin = Math.min(...rssValues);
  const rssMax = Math.max(...rssValues);
  const rssAvg = rssValues.reduce((a, b) => a + b, 0) / rssValues.length;

  console.log('\n📈 内存统计分析');
  console.log('═'.repeat(50));
  console.log(`采样数量: ${memorySamples.length}`);
  console.log(`测试时长: ${((memorySamples[memorySamples.length-1]?.time || 0) / 1000).toFixed(1)} 秒`);
  console.log('');
  console.log('Heap 使用:');
  console.log(`  最小: ${formatMemory(heapMin)}`);
  console.log(`  最大: ${formatMemory(heapMax)}`);
  console.log(`  平均: ${formatMemory(heapAvg)}`);
  console.log('');
  console.log('RSS (常驻内存):');
  console.log(`  最小: ${formatMemory(rssMin)}`);
  console.log(`  最大: ${formatMemory(rssMax)}`);
  console.log(`  平均: ${formatMemory(rssAvg)}`);
  console.log('');

  // 评估是否达到目标
  const TARGET_HEAP = 20 * 1024 * 1024; // 20MB
  const TARGET_RSS = 50 * 1024 * 1024;  // 50MB (RSS 通常比 heap 大)

  if (heapAvg <= TARGET_HEAP) {
    console.log('✅ 堆内存使用达标！平均使用低于 20MB 目标。');
  } else {
    console.log(`⚠️ 堆内存使用未达标。平均 ${formatMemory(heapAvg)}，目标 20MB。`);
  }

  if (heapMax - heapMin < 10 * 1024 * 1024) {
    console.log('✅ 内存波动稳定！波动范围小于 10MB。');
  } else {
    console.log(`⚠️ 内存波动较大。范围: ${formatMemory(heapMax - heapMin)}`);
  }
}

/**
 * 主测试流程
 */
async function runTest() {
  console.log('🧪 反重力服务内存优化测试');
  console.log('═'.repeat(50));
  console.log(`目标: 堆内存保持在 ~20MB`);
  console.log(`测试时长: ${TEST_DURATION_MS / 1000} 秒`);
  console.log(`采样间隔: ${SAMPLE_INTERVAL_MS / 1000} 秒`);
  console.log('═'.repeat(50));
  console.log('');

  try {
    await startServer();
    console.log('✅ 服务器已启动\n');
    
    testStartTime = Date.now();
    
    // 设置采样定时器
    const sampleInterval = setInterval(collectMemorySample, SAMPLE_INTERVAL_MS);
    
    // 设置负载模拟定时器
    const loadInterval = setInterval(simulateLoad, REQUEST_INTERVAL_MS);
    
    // 等待测试完成
    await new Promise(resolve => setTimeout(resolve, TEST_DURATION_MS));
    
    // 清理定时器
    clearInterval(sampleInterval);
    clearInterval(loadInterval);
    
    // 最后采集一次
    await collectMemorySample();
    
    // 分析结果
    analyzeResults();
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
  } finally {
    stopServer();
    process.exit(0);
  }
}

// 处理进程退出
process.on('SIGINT', () => {
  console.log('\n收到中断信号...');
  stopServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopServer();
  process.exit(0);
});

// 运行测试
runTest();

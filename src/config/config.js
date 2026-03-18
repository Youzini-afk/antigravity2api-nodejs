import dotenv from 'dotenv';
import fs from 'fs';
import crypto from 'crypto';
import log from '../utils/logger.js';
import { deepMerge } from '../utils/deepMerge.js';
import { getConfigPaths } from '../utils/paths.js';
import { parseEnvFile } from '../utils/envParser.js';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_HOST,
  DEFAULT_HEARTBEAT_INTERVAL,
  DEFAULT_TIMEOUT,
  DEFAULT_RETRY_TIMES,
  DEFAULT_MAX_REQUEST_SIZE,
  DEFAULT_MAX_IMAGES,
  MODEL_LIST_CACHE_TTL,
  DEFAULT_GENERATION_PARAMS,
  MEMORY_CLEANUP_INTERVAL
} from '../constants/index.js';

// 生成随机凭据的缓存
let generatedCredentials = null;
// 生成的 API_KEY 缓存
let generatedApiKey = null;

function getFirstNonEmptyEnv(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return '';
}

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function parsePositiveIntEnv(envName, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[envName];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

/**
 * 生成或获取 API_KEY
 * 如果用户未配置，自动生成随机密钥
 */
function getApiKey() {
  const apiKey = getFirstNonEmptyEnv(['API_KEY', 'APIKEY']);

  if (apiKey) {
    return apiKey;
  }

  // 生成随机 API_KEY（只生成一次）
  if (!generatedApiKey) {
    generatedApiKey = 'sk-' + crypto.randomBytes(24).toString('hex');
  }

  return generatedApiKey;
}

/**
 * 解析阈值绕过 API Key 列表
 * 支持逗号分隔或换行分隔，自动 trim、去重、忽略空项
 * @returns {string[]}
 */
function parseEnvKeyList(envKey) {
  const raw = process.env[envKey];
  if (!raw || typeof raw !== 'string') {
    return [];
  }

  const normalizedRaw = raw
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n');
  const parts = normalizedRaw.split(/[\n,;，；]/);
  const result = [];
  const seen = new Set();

  for (const part of parts) {
    const value = part
      .trim()
      .replace(/^['"]+/, '')
      .replace(/['"]+$/, '');
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }

  return result;
}

function parseBypassThresholdApiKeys() {
  return parseEnvKeyList('BYPASS_THRESHOLD_API_KEYS');
}

function parseUnrestrictedApiKeys() {
  return parseEnvKeyList('UNRESTRICTED_API_KEYS');
}

function parseExternalApiKey() {
  const raw = process.env.EXTERNAL_API_KEY;
  return (typeof raw === 'string' && raw.trim()) ? raw.trim() : '';
}

// 是否已显示过凭据提示
let credentialsDisplayed = false;

/**
 * 生成或获取管理员凭据
 * 如果用户未配置，自动生成随机凭据
 */
function getAdminCredentials() {
  const username = getFirstNonEmptyEnv(['ADMIN_USERNAME', 'ADMIN_USERNAM']);
  const password = getFirstNonEmptyEnv(['ADMIN_PASSWORD']);
  const jwtSecret = getFirstNonEmptyEnv(['JWT_SECRET']);

  // 如果全部配置了，直接返回
  if (username && password && jwtSecret) {
    return { username, password, jwtSecret };
  }

  // 生成随机凭据（只生成一次）
  if (!generatedCredentials) {
    generatedCredentials = {
      username: username || crypto.randomBytes(8).toString('hex'),
      password: password || crypto.randomBytes(16).toString('base64').replace(/[+/=]/g, ''),
      jwtSecret: jwtSecret || crypto.randomBytes(32).toString('hex')
    };
  }

  return generatedCredentials;
}

/**
 * 显示生成的凭据提示（只显示一次）
 */
function displayGeneratedCredentials() {
  if (credentialsDisplayed) return;
  credentialsDisplayed = true;

  const username = getFirstNonEmptyEnv(['ADMIN_USERNAME', 'ADMIN_USERNAM']);
  const password = getFirstNonEmptyEnv(['ADMIN_PASSWORD']);
  const apiKey = getFirstNonEmptyEnv(['API_KEY', 'APIKEY']);
  const jwtSecret = getFirstNonEmptyEnv(['JWT_SECRET']);

  const needsUsername = !username;
  const needsPassword = !password;
  const needsApiKey = !apiKey;
  const needsJwtSecret = !jwtSecret;

  // 如果有任何凭据需要生成，显示提示
  if (needsUsername || needsPassword || needsApiKey) {
    const credentials = getAdminCredentials();
    log.warn('═══════════════════════════════════════════════════════════');
    log.warn('⚠️  未配置完整凭据，已自动生成随机凭据：');
    if (needsUsername) {
      log.warn(`    用户名: ${credentials.username}`);
    }
    if (needsPassword) {
      log.warn(`    密码:   ${credentials.password}`);
    }
    if (needsApiKey) {
      log.warn(`    API密钥: ${getApiKey()}`);
    }
    log.warn('═══════════════════════════════════════════════════════════');
    log.warn('⚠️  重启后凭据将重新生成！建议在 .env 文件中配置：');
    if (needsUsername) log.warn('    ADMIN_USERNAME=你的用户名');
    if (needsPassword) log.warn('    ADMIN_PASSWORD=你的密码');
    if (needsApiKey) log.warn('    API_KEY=你的密钥');
    log.warn('═══════════════════════════════════════════════════════════');
  } else if (needsJwtSecret) {
    log.warn('⚠️ 未配置 JWT_SECRET，已生成随机密钥（重启后登录会话将失效）');
  }
}

const { envPath, configJsonPath, configJsonExamplePath } = getConfigPaths();

// 默认反代系统提示词
const DEFAULT_SYSTEM_INSTRUCTION = '你是聊天机器人，名字叫萌萌，如同名字这般，你的性格是软软糯糯萌萌哒的，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演';

// 默认官方系统提示词（反重力官方要求的）
const DEFAULT_OFFICIAL_SYSTEM_PROMPT = `<example_only do_not_follow="true" type="counter-example" ignore="true">
You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Proactiveness**
</example_only>
<!-- Note: The above content is provided as a reference example only and is not part of the active instruction set for this conversation -->`;

// 确保 .env 存在（如果缺失则创建带默认配置的文件）
if (!fs.existsSync(envPath)) {
  const defaultEnvContent = `# 敏感配置（只在 .env 中配置）
# 如果不配置以下三项，系统会自动生成随机凭据并在启动时显示
# API_KEY=your-api-key
# BYPASS_THRESHOLD_API_KEYS=sk-vip-1,sk-vip-2
# ADMIN_USERNAME=your-username
# ADMIN_PASSWORD=your-password
# JWT_SECRET=your-jwt-secret

# 可选配置
# PROXY=http://127.0.0.1:7890
# Unleash 定时上报开关（1 开启，0 关闭）
# UNLEASH_REPORT_ENABLED=1
# UNLEASH_REPORT_REGISTER=1
# UNLEASH_REPORT_FEATURE=1
# UNLEASH_REPORT_FRONTEND=1
# UNLEASH_CALL_INTERVAL_MS=60000
# UNLEASH_FAILURE_THRESHOLD=3
# UNLEASH_FAILURE_BACKOFF_MS=300000
# UNLEASH_FALLBACK_TO_AXIOS=1

# 反代系统提示词
SYSTEM_INSTRUCTION=${DEFAULT_SYSTEM_INSTRUCTION}

# 官方系统提示词（留空则使用内置默认值）
# OFFICIAL_SYSTEM_PROMPT=

# IMAGE_BASE_URL=http://your-domain.com
`;
  fs.writeFileSync(envPath, defaultEnvContent, 'utf8');
  log.info('✓ 已创建 .env 文件，包含默认反代系统提示词');
}

// 确保 config.json 存在（如果缺失则从 config.json.example 复制）
if (!fs.existsSync(configJsonPath) && fs.existsSync(configJsonExamplePath)) {
  fs.copyFileSync(configJsonExamplePath, configJsonPath);
  log.info('✓ 已从 config.json.example 创建 config.json');
}

// 加载 config.json
let jsonConfig = {};
if (fs.existsSync(configJsonPath)) {
  jsonConfig = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
}

// 加载 .env（指定路径）
dotenv.config({ path: envPath });

// 处理系统提示词中的转义字符
// dotenv 不会自动将 \n 字符串转换为实际换行符，我们需要手动处理
function processEscapeChars(value) {
  if (!value) return value;
  return value
    .replace(/\\\\n/g, '\n')  // 先处理双重转义 \\n -> 换行
    .replace(/\\n/g, '\n');   // 再处理单重转义 \n -> 换行
}

if (process.env.SYSTEM_INSTRUCTION) {
  process.env.SYSTEM_INSTRUCTION = processEscapeChars(process.env.SYSTEM_INSTRUCTION);
}

if (process.env.OFFICIAL_SYSTEM_PROMPT) {
  process.env.OFFICIAL_SYSTEM_PROMPT = processEscapeChars(process.env.OFFICIAL_SYSTEM_PROMPT);
}

// 对于系统提示词，使用自定义解析器重新加载以支持更复杂的多行格式
// dotenv 的解析可能不够完善，我们用自定义解析器补充
try {
  const customEnv = parseEnvFile(envPath);
  if (customEnv.SYSTEM_INSTRUCTION) {
    let customValue = processEscapeChars(customEnv.SYSTEM_INSTRUCTION);
    // 如果自定义解析器得到的值更长，使用它
    if (customValue.length > (process.env.SYSTEM_INSTRUCTION?.length || 0)) {
      process.env.SYSTEM_INSTRUCTION = customValue;
    }
  }
  if (customEnv.OFFICIAL_SYSTEM_PROMPT) {
    let customValue = processEscapeChars(customEnv.OFFICIAL_SYSTEM_PROMPT);
    // 如果自定义解析器得到的值更长，使用它
    if (customValue.length > (process.env.OFFICIAL_SYSTEM_PROMPT?.length || 0)) {
      process.env.OFFICIAL_SYSTEM_PROMPT = customValue;
    }
  }
} catch (e) {
  // 忽略解析错误，使用 dotenv 的结果
}

// 获取代理配置：优先使用 PROXY，其次使用系统代理环境变量
export function getProxyConfig() {
  // 优先使用显式配置的 PROXY
  if (process.env.PROXY) {
    return process.env.PROXY;
  }

  // 检查系统代理环境变量（按优先级）
  const systemProxy = process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;

  if (systemProxy) {
    log.info(`使用系统代理: ${systemProxy}`);
  }

  return systemProxy || null;
}

// 默认 API 配置（Antigravity）
const DEFAULT_API_CONFIGS = {
  sandbox: {
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    noStreamUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:generateContent',
    recordTrajectory: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:recordTrajectoryAnalytics',
    recordCodeAssistMetrics: "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:recordCodeAssistMetrics",
    host: 'daily-cloudcode-pa.sandbox.googleapis.com'
  },
  production: {
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
    noStreamUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent',
    recordTrajectory: 'https://daily-cloudcode-pa.googleapis.com/v1internal:recordTrajectoryAnalytics',
    recordCodeAssistMetrics: "https://daily-cloudcode-pa.googleapis.com/v1internal:recordCodeAssistMetrics",
    host: 'daily-cloudcode-pa.googleapis.com'
  }
};

const DEFAULT_API_UNLEASH = {
    register: "https://antigravity-unleash.goog/api/client/register",
    features: "https://antigravity-unleash.goog/api/client/features",
    frontend: "https://antigravity-unleash.goog/api/frontend"
}

// Gemini CLI API 配置（来自 gcli2api 项目）
// 使用 v1internal 端点，模型名称在请求体中指定
const DEFAULT_GEMINICLI_API_CONFIG = {
  url: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  noStreamUrl: 'https://cloudcode-pa.googleapis.com/v1internal:generateContent',
  modelsUrl: 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
  host: 'cloudcode-pa.googleapis.com',
  userAgent: 'GeminiCLI/0.1.5 (Windows; AMD64)'
};

const DEFAULT_THRESHOLD_POLICY = {
  enabled: false,
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

const ERROR_REWRITE_VALID_SCOPES = ['openai', 'gemini', 'claude'];
const ERROR_REWRITE_STRING_FIELDS = ['typeExact', 'codeExact', 'messageExact', 'messageContains', 'rawExact', 'rawContains'];
const DEFAULT_ERROR_REWRITE_RULE = Object.freeze({
  id: '',
  enabled: true,
  logic: 'and',
  scope: ERROR_REWRITE_VALID_SCOPES,
  match: {
    statusCodes: [],
    typeExact: [],
    codeExact: [],
    messageExact: [],
    messageContains: [],
    rawExact: [],
    rawContains: []
  },
  rewrite: {
    mode: 'replace',
    message: ''
  }
});
const DEFAULT_ERROR_REWRITE_POLICY = Object.freeze({
  enabled: false,
  rules: []
});

const DEFAULT_TOKEN_MESSAGES = Object.freeze({
  pool_empty: '凭证池为空，请先添加凭证（npm run login）',
  all_disabled: '所有凭证已被禁用，请检查凭证状态',
  quota_exhausted: '所有凭证额度已耗尽，预计 {reset_time} 恢复',
  model_exhausted: '模型 {model} 无可用凭证，预计 {reset_time} 恢复',
  threshold_strict: '模型 {model} 所有凭证均低于额度阈值（严格模式）',
  no_available: '没有可用的凭证'
});
const DEFAULT_RESET_TIME_OFFSET_MINUTES = 15;
const TOKEN_MESSAGE_KEYS = Object.keys(DEFAULT_TOKEN_MESSAGES);

const DEFAULT_CLIENT_RESTRICTION = Object.freeze({
  enabled: false,
  blockToolCalls: true,
  toolCallAction: 'strip',
  uaBlacklist: [],
  systemPromptBlacklist: [],
  messages: {
    uaBlocked: '检测到不支持的客户端，请使用其他客户端',
    toolCallBlocked: '当前接口不支持工具调用',
    systemPromptBlocked: '检测到不允许的系统提示词'
  }
});

const DEFAULT_REQUEST_INTERCEPTION = Object.freeze({
  enabled: false,
  external: {
    baseUrl: '',
    model: '',
    systemPrompt: '',
    temperature: 0.7,
    maxTokens: 4096
  },
  testMessage: {
    enabled: true,
    maxLength: 20,
    keywordsEnabled: false,
    keywords: ['test', '你好', 'hi', 'hello', '测试']
  },
  modelRules: []
});


function normalizeThresholdPolicy(policy) {
  const base = JSON.parse(JSON.stringify(DEFAULT_THRESHOLD_POLICY));
  if (!policy || typeof policy !== 'object') return base;

  if (typeof policy.enabled === 'boolean') {
    base.enabled = policy.enabled;
  }
  if (typeof policy.crossModelGlobalBlock === 'boolean') {
    base.crossModelGlobalBlock = policy.crossModelGlobalBlock;
  }

  const normalizePercent = (value, fallback) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    if (num < 0) return 0;
    if (num > 100) return 100;
    return num;
  };

  base.modelGroupPercent = normalizePercent(policy.modelGroupPercent, base.modelGroupPercent);
  base.globalPercent = normalizePercent(policy.globalPercent, base.globalPercent);

  if (policy.applyStrategies && typeof policy.applyStrategies === 'object') {
    const allowed = ['round_robin', 'request_count', 'quota_exhausted'];
    for (const key of allowed) {
      if (typeof policy.applyStrategies[key] === 'boolean') {
        base.applyStrategies[key] = policy.applyStrategies[key];
      }
    }
  }

  if (policy.allBelowThresholdAction === 'strict' || policy.allBelowThresholdAction === 'fail_open') {
    base.allBelowThresholdAction = policy.allBelowThresholdAction;
  }

  return base;
}

function mergeThresholdPolicyWithFallback(globalPolicyInput, cliPolicyInput) {
  const globalPolicy = normalizeThresholdPolicy(globalPolicyInput);
  if (!cliPolicyInput || typeof cliPolicyInput !== 'object') {
    return globalPolicy;
  }

  return normalizeThresholdPolicy({
    ...globalPolicy,
    ...cliPolicyInput,
    applyStrategies: {
      ...globalPolicy.applyStrategies,
      ...(cliPolicyInput.applyStrategies && typeof cliPolicyInput.applyStrategies === 'object'
        ? cliPolicyInput.applyStrategies
        : {})
    }
  });
}

function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const values = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function normalizeStatusCodes(arr) {
  if (!Array.isArray(arr)) return [];
  const values = [];
  const seen = new Set();
  for (const item of arr) {
    const num = Number(item);
    if (!Number.isInteger(num) || num < 100 || num > 599 || seen.has(num)) continue;
    seen.add(num);
    values.push(num);
  }
  return values;
}

function normalizeErrorRewriteRule(rule, index) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;

  const id = typeof rule.id === 'string' && rule.id.trim()
    ? rule.id.trim()
    : `rule-${index + 1}`;
  const enabled = typeof rule.enabled === 'boolean' ? rule.enabled : true;
  const logic = rule.logic === 'or' ? 'or' : 'and';
  const scope = normalizeStringArray(rule.scope).filter(item => ERROR_REWRITE_VALID_SCOPES.includes(item));
  const normalizedScope = scope.length > 0 ? scope : [...ERROR_REWRITE_VALID_SCOPES];
  const rawMatch = rule.match && typeof rule.match === 'object' && !Array.isArray(rule.match) ? rule.match : {};

  const match = {
    statusCodes: normalizeStatusCodes(rawMatch.statusCodes),
    typeExact: normalizeStringArray(rawMatch.typeExact),
    codeExact: normalizeStringArray(rawMatch.codeExact),
    messageExact: normalizeStringArray(rawMatch.messageExact),
    messageContains: normalizeStringArray(rawMatch.messageContains),
    rawExact: normalizeStringArray(rawMatch.rawExact),
    rawContains: normalizeStringArray(rawMatch.rawContains)
  };

  const hasAnyMatch =
    match.statusCodes.length > 0 ||
    ERROR_REWRITE_STRING_FIELDS.some(field => match[field].length > 0);
  if (!hasAnyMatch) return null;

  const rawRewrite = rule.rewrite && typeof rule.rewrite === 'object' && !Array.isArray(rule.rewrite) ? rule.rewrite : {};
  const mode = rawRewrite.mode === 'prepend' || rawRewrite.mode === 'append' ? rawRewrite.mode : 'replace';
  const message = typeof rawRewrite.message === 'string' ? rawRewrite.message.trim() : '';
  if (!message) return null;

  return {
    ...DEFAULT_ERROR_REWRITE_RULE,
    id,
    enabled,
    logic,
    scope: normalizedScope,
    match,
    rewrite: {
      mode,
      message
    }
  };
}

function normalizeErrorRewritePolicy(policy) {
  const base = {
    enabled: DEFAULT_ERROR_REWRITE_POLICY.enabled,
    rules: []
  };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    return base;
  }

  if (typeof policy.enabled === 'boolean') {
    base.enabled = policy.enabled;
  }

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  base.rules = rules
    .map((rule, index) => normalizeErrorRewriteRule(rule, index))
    .filter(Boolean);

  return base;
}

/**
 * 获取当前使用的 API 配置（Antigravity）
 * @param {Object} jsonConfig - JSON 配置对象
 * @returns {Object} 当前 API 配置
 */

function normalizeClientRestriction(input) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CLIENT_RESTRICTION));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;

  if (typeof input.enabled === 'boolean') base.enabled = input.enabled;
  if (typeof input.blockToolCalls === 'boolean') base.blockToolCalls = input.blockToolCalls;
  if (input.toolCallAction === 'strip' || input.toolCallAction === 'reject') {
    base.toolCallAction = input.toolCallAction;
  }
  if (Array.isArray(input.uaBlacklist)) {
    base.uaBlacklist = input.uaBlacklist.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().toLowerCase());
  }
  if (Array.isArray(input.systemPromptBlacklist)) {
    base.systemPromptBlacklist = input.systemPromptBlacklist.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
  }
  if (input.messages && typeof input.messages === 'object') {
    for (const key of ['uaBlocked', 'toolCallBlocked', 'systemPromptBlocked']) {
      if (typeof input.messages[key] === 'string' && input.messages[key].trim()) {
        base.messages[key] = input.messages[key].trim();
      }
    }
  }
  return base;
}

function normalizeRequestInterception(input) {
  const base = JSON.parse(JSON.stringify(DEFAULT_REQUEST_INTERCEPTION));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;

  if (typeof input.enabled === 'boolean') base.enabled = input.enabled;

  // 外部模型配置
  if (input.external && typeof input.external === 'object') {
    if (typeof input.external.baseUrl === 'string') base.external.baseUrl = input.external.baseUrl.trim().replace(/\/+$/, '');
    if (typeof input.external.model === 'string') base.external.model = input.external.model.trim();
    if (typeof input.external.systemPrompt === 'string') base.external.systemPrompt = input.external.systemPrompt;
    if (typeof input.external.temperature === 'number' && Number.isFinite(input.external.temperature)) {
      base.external.temperature = Math.max(0, input.external.temperature);
    }
    if (typeof input.external.maxTokens === 'number' && Number.isFinite(input.external.maxTokens)) {
      base.external.maxTokens = Math.max(1, Math.floor(input.external.maxTokens));
    }
  }

  // 测试消息配置
  if (input.testMessage && typeof input.testMessage === 'object') {
    if (typeof input.testMessage.enabled === 'boolean') base.testMessage.enabled = input.testMessage.enabled;
    if (typeof input.testMessage.keywordsEnabled === 'boolean') base.testMessage.keywordsEnabled = input.testMessage.keywordsEnabled;
    if (typeof input.testMessage.maxLength === 'number' && Number.isFinite(input.testMessage.maxLength)) {
      base.testMessage.maxLength = Math.max(1, Math.floor(input.testMessage.maxLength));
    }
    if (Array.isArray(input.testMessage.keywords)) {
      base.testMessage.keywords = input.testMessage.keywords
        .filter(v => typeof v === 'string' && v.trim())
        .map(v => v.trim().toLowerCase());
    }
  }

  // 模型规则
  if (Array.isArray(input.modelRules)) {
    base.modelRules = input.modelRules
      .filter(r => r && typeof r === 'object' && typeof r.pattern === 'string' && r.pattern.trim())
      .map(r => ({
        pattern: r.pattern.trim(),
        maxTemperature: typeof r.maxTemperature === 'number' && Number.isFinite(r.maxTemperature) ? r.maxTemperature : null,
        maxTokens: typeof r.maxTokens === 'number' && Number.isFinite(r.maxTokens) ? Math.floor(r.maxTokens) : null,
        noPrefill: r.noPrefill === true,
        requireUserLast: r.requireUserLast === true
      }));
  }

  return base;
}

function normalizeTokenMessages(input) {
  const base = { ...DEFAULT_TOKEN_MESSAGES, resetTimeOffsetMinutes: DEFAULT_RESET_TIME_OFFSET_MINUTES };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;

  for (const key of TOKEN_MESSAGE_KEYS) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      base[key] = input[key].trim();
    }
  }

  if (typeof input.resetTimeOffsetMinutes === 'number' && Number.isFinite(input.resetTimeOffsetMinutes)) {
    base.resetTimeOffsetMinutes = Math.max(0, Math.floor(input.resetTimeOffsetMinutes));
  }

  return base;
}

function getActiveApiConfig(jsonConfig) {
  const apiUse = jsonConfig.api?.use || 'production';
  const customConfig = jsonConfig.api?.[apiUse];
  const defaultConfig = DEFAULT_API_CONFIGS[apiUse] || DEFAULT_API_CONFIGS.production;
  const unleash = jsonConfig.api?.unleash || DEFAULT_API_UNLEASH

  return {
    use: apiUse,
    url: customConfig?.url || defaultConfig.url,
    modelsUrl: customConfig?.modelsUrl || defaultConfig.modelsUrl,
    noStreamUrl: customConfig?.noStreamUrl || defaultConfig.noStreamUrl,
    recordTrajectory: customConfig?.recordTrajectory || defaultConfig.recordTrajectory,
    recordCodeAssistMetrics: customConfig?.recordCodeAssistMetrics || defaultConfig.recordCodeAssistMetrics,
    host: customConfig?.host || defaultConfig.host,
    userAgent: `antigravity/${jsonConfig.api?.version || "1.19.5" } windows/amd64`,
    ideVersion: jsonConfig.api?.version || "1.19.5",
    unleash: unleash
  };
}

/**
 * 获取 Gemini CLI API 配置
 * @param {Object} jsonConfig - JSON 配置对象
 * @returns {Object} Gemini CLI API 配置
 */
function getGeminiCliApiConfig(jsonConfig) {
  const customConfig = jsonConfig.geminicli?.api;

  return {
    url: customConfig?.url || DEFAULT_GEMINICLI_API_CONFIG.url,
    noStreamUrl: customConfig?.noStreamUrl || DEFAULT_GEMINICLI_API_CONFIG.noStreamUrl,
    modelsUrl: customConfig?.modelsUrl || DEFAULT_GEMINICLI_API_CONFIG.modelsUrl,
    host: customConfig?.host || DEFAULT_GEMINICLI_API_CONFIG.host,
    userAgent: customConfig?.userAgent || DEFAULT_GEMINICLI_API_CONFIG.userAgent
  };
}

/**
 * 从 JSON 和环境变量构建配置对象
 * @param {Object} jsonConfig - JSON 配置对象
 * @returns {Object} 完整配置对象
 */
export function buildConfig(jsonConfig) {
  const apiConfig = getActiveApiConfig(jsonConfig);
  const globalThresholdPolicy = normalizeThresholdPolicy(jsonConfig.rotation?.thresholdPolicy);
  const cliThresholdPolicy = mergeThresholdPolicyWithFallback(
    jsonConfig.rotation?.thresholdPolicy,
    jsonConfig.geminicli?.rotation?.thresholdPolicy
  );
  const errorRewritePolicy = normalizeErrorRewritePolicy(jsonConfig.errorRewrite);
  const tokenMessages = normalizeTokenMessages(jsonConfig.tokenMessages);

  return {
    server: {
      port: jsonConfig.server?.port || DEFAULT_SERVER_PORT,
      host: jsonConfig.server?.host || DEFAULT_SERVER_HOST,
      heartbeatInterval: jsonConfig.server?.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL,
      // 内存定时清理频率：避免频繁扫描/GC 带来的性能损耗
      memoryCleanupInterval: jsonConfig.server?.memoryCleanupInterval ?? MEMORY_CLEANUP_INTERVAL
    },
    cache: {
      modelListTTL: jsonConfig.cache?.modelListTTL || MODEL_LIST_CACHE_TTL
    },
    rotation: {
      strategy: jsonConfig.rotation?.strategy || 'round_robin',
      requestCount: jsonConfig.rotation?.requestCount || 10,
      thresholdPolicy: globalThresholdPolicy
    },
    errorRewrite: errorRewritePolicy,
    tokenMessages,
    // 日志配置
    log: {
      maxSizeMB: jsonConfig.log?.maxSizeMB || 10,    // 单个日志文件最大 MB
      maxFiles: jsonConfig.log?.maxFiles || 5,       // 保留历史文件数
      maxMemory: jsonConfig.log?.maxMemory || 500    // 内存中保留条数
    },
    imageBaseUrl: process.env.IMAGE_BASE_URL || null,
    maxImages: jsonConfig.other?.maxImages || DEFAULT_MAX_IMAGES,
    api: apiConfig,
    defaults: {
      temperature: jsonConfig.defaults?.temperature ?? DEFAULT_GENERATION_PARAMS.temperature,
      top_p: jsonConfig.defaults?.topP ?? DEFAULT_GENERATION_PARAMS.top_p,
      top_k: jsonConfig.defaults?.topK ?? DEFAULT_GENERATION_PARAMS.top_k,
      max_tokens: jsonConfig.defaults?.maxTokens ?? DEFAULT_GENERATION_PARAMS.max_tokens,
      thinking_budget: jsonConfig.defaults?.thinkingBudget ?? DEFAULT_GENERATION_PARAMS.thinking_budget
    },
    clientRestriction: normalizeClientRestriction(jsonConfig.clientRestriction),
    requestInterception: (() => {
      const ri = normalizeRequestInterception(jsonConfig.requestInterception);
      ri.external.apiKey = parseExternalApiKey();
      return ri;
    })(),
    security: {
      maxRequestSize: jsonConfig.server?.maxRequestSize || DEFAULT_MAX_REQUEST_SIZE,
      apiKey: getApiKey(),
      bypassThresholdApiKeys: parseBypassThresholdApiKeys(),
      unrestrictedApiKeys: parseUnrestrictedApiKeys()
    },
    unleashControl: {
      enabled: parseBooleanEnv(process.env.UNLEASH_REPORT_ENABLED, true),
      callIntervalMs: parsePositiveIntEnv('UNLEASH_CALL_INTERVAL_MS', 60 * 1000, { min: 5000 }),
      failureBackoffMs: parsePositiveIntEnv('UNLEASH_FAILURE_BACKOFF_MS', 5 * 60 * 1000, { min: 1000 }),
      failureThreshold: parsePositiveIntEnv('UNLEASH_FAILURE_THRESHOLD', 3, { min: 1, max: 100 }),
      fallbackToAxios: parseBooleanEnv(process.env.UNLEASH_FALLBACK_TO_AXIOS, true),
      endpoints: {
        register: parseBooleanEnv(process.env.UNLEASH_REPORT_REGISTER, true),
        feature: parseBooleanEnv(process.env.UNLEASH_REPORT_FEATURE, true),
        frontend: parseBooleanEnv(process.env.UNLEASH_REPORT_FRONTEND, true)
      }
    },
    admin: getAdminCredentials(),
    useNativeAxios: jsonConfig.other?.useNativeAxios !== false,
    forceIPv4: jsonConfig.other?.forceIPv4 === true,
    timeout: jsonConfig.other?.timeout || DEFAULT_TIMEOUT,
    retryTimes: Number.isFinite(jsonConfig.other?.retryTimes) ? jsonConfig.other.retryTimes : DEFAULT_RETRY_TIMES,
    proxy: getProxyConfig(),
    // 反代系统提示词（从 .env 读取，可在前端修改，空字符串代表不使用）
    systemInstruction: process.env.SYSTEM_INSTRUCTION ?? '',
    // 官方系统提示词（从 .env 读取，可在前端修改，空字符串代表不使用）
    officialSystemPrompt: process.env.OFFICIAL_SYSTEM_PROMPT ?? DEFAULT_OFFICIAL_SYSTEM_PROMPT,
    // 官方提示词位置配置：'before' = 官方提示词在反代提示词前面，'after' = 官方提示词在反代提示词后面
    officialPromptPosition: jsonConfig.other?.officialPromptPosition || 'before',
    // 是否合并系统提示词为单个 part，false 则保留多 part 结构（需要先开启 useContextSystemPrompt）
    mergeSystemPrompt: jsonConfig.other?.mergeSystemPrompt !== false,
    skipProjectIdFetch: jsonConfig.other?.skipProjectIdFetch === true,
    // 可配置的自动封禁（学习 gcli2api 的 auto_ban 功能）
    antiTruncation: {
      maxAttempts: Number.isFinite(jsonConfig.other?.antiTruncation?.maxAttempts)
        ? jsonConfig.other.antiTruncation.maxAttempts
        : 3,
    },
    autoBan: {
      enabled: jsonConfig.other?.autoBan?.enabled !== false,
      errorCodes: Array.isArray(jsonConfig.other?.autoBan?.errorCodes)
        ? jsonConfig.other.autoBan.errorCodes
        : [403],  // 默认只禁用 403
    },
    // 获取 projectId 时使用的 API Host（可独立配置，默认与主 API 相同）
    // 参考 gcli2api 项目，可设置为 sandbox 端点: daily-cloudcode-pa.sandbox.googleapis.com
    projectIdApiHost: jsonConfig.api?.projectIdHost || apiConfig.host,
    // 获取 projectId 时使用的 User-Agent（可独立配置，默认与主 API 相同）
    projectIdUserAgent: jsonConfig.api?.projectIdUserAgent || apiConfig.userAgent,
    useContextSystemPrompt: jsonConfig.other?.useContextSystemPrompt === true,
    passSignatureToClient: jsonConfig.other?.passSignatureToClient === true,
    useFallbackSignature: jsonConfig.other?.useFallbackSignature === true,
    // 签名缓存配置（新版）
    cacheAllSignatures: jsonConfig.other?.cacheAllSignatures === true ||
      process.env.CACHE_ALL_SIGNATURES === '1' ||
      process.env.CACHE_ALL_SIGNATURES === 'true',
    cacheToolSignatures: jsonConfig.other?.cacheToolSignatures !== false,
    cacheImageSignatures: jsonConfig.other?.cacheImageSignatures !== false,
    cacheThinking: jsonConfig.other?.cacheThinking !== false,
    // 假非流：非流式请求使用流式获取数据后返回非流式格式（默认启用）
    fakeNonStream: jsonConfig.other?.fakeNonStream !== false,
    // 调试：完整打印最终请求体与原始响应（可能包含敏感内容/大体积数据，只从环境变量读取）
    debugDumpRequestResponse: process.env.DEBUG_DUMP_REQUEST_RESPONSE === '1',

    // ==================== Gemini CLI 配置 ====================
    geminicli: {
      // 是否启用 Gemini CLI 反代功能
      enabled: jsonConfig.geminicli?.enabled !== false,
      // API 配置
      api: getGeminiCliApiConfig(jsonConfig),
      // Token 轮换策略
      rotation: {
        strategy: jsonConfig.geminicli?.rotation?.strategy || 'round_robin',
        requestCount: jsonConfig.geminicli?.rotation?.requestCount || 10,
        thresholdPolicy: cliThresholdPolicy
      },
      // 默认生成参数（可覆盖全局默认值）
      defaults: {
        temperature: jsonConfig.geminicli?.defaults?.temperature ?? jsonConfig.defaults?.temperature ?? DEFAULT_GENERATION_PARAMS.temperature,
        top_p: jsonConfig.geminicli?.defaults?.topP ?? jsonConfig.defaults?.topP ?? DEFAULT_GENERATION_PARAMS.top_p,
        top_k: jsonConfig.geminicli?.defaults?.topK ?? jsonConfig.defaults?.topK ?? DEFAULT_GENERATION_PARAMS.top_k,
        max_tokens: jsonConfig.geminicli?.defaults?.maxTokens ?? jsonConfig.defaults?.maxTokens ?? DEFAULT_GENERATION_PARAMS.max_tokens,
        thinking_budget: jsonConfig.geminicli?.defaults?.thinkingBudget ?? jsonConfig.defaults?.thinkingBudget ?? DEFAULT_GENERATION_PARAMS.thinking_budget
      }
    }
  };
}

const config = buildConfig(jsonConfig);

// 版本更新检查接口
const VERSION_CHECK_URL = 'https://antigravity-auto-updater-974169037036.us-central1.run.app/releases';

/**
 * 比较两个语义化版本号
 * @param {string} a - 版本号 a
 * @param {string} b - 版本号 b
 * @returns {number} a > b 返回 1，a < b 返回 -1，相等返回 0
 */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/**
 * 检查并更新版本号
 * 从远程接口获取最新版本，如果有更新则更新 config.json 和内存中的配置
 */
export async function checkAndUpdateVersion() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(VERSION_CHECK_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      log.warn(`版本检查请求失败: HTTP ${response.status}`);
      return;
    }

    const releases = await response.json();
    if (!Array.isArray(releases) || releases.length === 0 || !releases[0].version) {
      log.warn('版本检查返回数据格式异常');
      return;
    }

    const latestVersion = releases[0].version;
    const currentVersion = config.api.ideVersion;

    if (compareVersions(latestVersion, currentVersion) > 0) {
      log.info(`发现新版本: ${currentVersion} → ${latestVersion}，正在更新配置...`);

      // 更新 config.json
      saveConfigJson({ api: { version: latestVersion } });

      // 更新内存中的配置
      config.api.ideVersion = latestVersion;
      config.api.userAgent = `antigravity/${latestVersion} windows/amd64`;

      log.info(`✓ 版本已更新为 ${latestVersion}`);
    } else {
      log.info(`当前版本 ${currentVersion} 已是最新`);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      log.warn('版本检查超时，跳过更新');
    } else {
      log.warn(`版本检查失败: ${err.message}`);
    }
  }
}

// 显示生成的凭据提示
displayGeneratedCredentials();

log.info('✓ 配置加载成功');

export default config;

export function getConfigJson() {
  if (fs.existsSync(configJsonPath)) {
    return JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
  }
  return {};
}

export function saveConfigJson(data) {
  const existing = getConfigJson();
  const merged = deepMerge(existing, data);
  fs.writeFileSync(configJsonPath, JSON.stringify(merged, null, 2), 'utf8');
}

#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.resolve(__dirname, '..');
const envFilePath = './.env';
const configFilePath = './config.json';
const dataDirPath = './data';
const imagesDirPath = './public/images';
const hostPort = process.env.COMPOSE_HOST_PORT || process.env.HOST_PORT || '8046';

const resolveLocalPath = (targetPath) => (
  path.isAbsolute(targetPath) ? targetPath : path.resolve(rootDir, targetPath)
);

const envFile = resolveLocalPath(envFilePath);
const configFile = resolveLocalPath(configFilePath);
const envExample = path.join(rootDir, '.env.example');
const configExample = path.join(rootDir, 'config.json.example');
const dataDir = resolveLocalPath(dataDirPath);
const imagesDir = resolveLocalPath(imagesDirPath);

console.log('🐳 开始构建 Docker 镜像...\n');
console.log(`项目名: ${process.env.COMPOSE_PROJECT_NAME || 'antigravity2api'}`);
console.log(`端口映射: ${hostPort}:8046`);
console.log(`配置文件: ${configFilePath}`);
console.log(`环境文件: ${envFilePath}\n`);
console.log(`环境文件绝对路径: ${envFile}`);
console.log(`配置文件绝对路径: ${configFile}\n`);

if (process.env.COMPOSE_ENV_FILE_PATH || process.env.ENV_FILE_PATH ||
    process.env.COMPOSE_CONFIG_FILE_PATH || process.env.CONFIG_FILE_PATH ||
    process.env.COMPOSE_DATA_DIR || process.env.DATA_DIR ||
    process.env.COMPOSE_IMAGES_DIR || process.env.IMAGES_DIR) {
  console.log('⚠ 检测到自定义路径环境变量，但当前版本 docker-compose 固定使用项目目录下 .env/config.json/data/public/images');
}

function readEnvFileValues(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const values = {};
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    values[key] = value;
  }
  return values;
}

// 确保配置文件目录存在
const envDir = path.dirname(envFile);
const configDir = path.dirname(configFile);
if (!fs.existsSync(envDir)) {
  fs.mkdirSync(envDir, { recursive: true });
}
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// 检查并复制 .env
if (!fs.existsSync(envFile)) {
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
    console.log('✓ 已从 .env.example 创建 .env');
  } else {
    console.warn('⚠ 未找到 .env.example，将使用默认配置');
  }
} else {
  console.log('✓ .env 已存在');
}

const envValues = readEnvFileValues(envFile);
const missingRequiredKeys = ['API_KEY', 'ADMIN_PASSWORD']
  .filter((key) => !envValues[key]);
const hasAdminUsername = Boolean(envValues.ADMIN_USERNAME || envValues.ADMIN_USERNAM);
if (!hasAdminUsername) missingRequiredKeys.push('ADMIN_USERNAME');

if (missingRequiredKeys.length > 0) {
  console.error(`❌ .env 缺少关键配置: ${missingRequiredKeys.join(', ')}`);
  console.error('  请先编辑项目目录下 .env，再重新执行 npm run docker:build');
  process.exit(1);
}

// 检查并复制 config.json
if (!fs.existsSync(configFile)) {
  if (fs.existsSync(configExample)) {
    fs.copyFileSync(configExample, configFile);
    console.log('✓ 已从 config.json.example 创建 config.json');
  } else {
    console.warn('⚠ 未找到 config.json.example，将使用默认配置');
  }
} else {
  console.log('✓ config.json 已存在');
}

// 确保必要的目录存在（防止 Docker 挂载时创建文件夹）
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('✓ 已创建 data 目录');
}

if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
  console.log('✓ 已创建 public/images 目录');
}

// 构建镜像
console.log('\n📦 正在构建镜像...\n');
try {
  execSync('docker compose build', { 
    cwd: rootDir, 
    stdio: 'inherit' 
  });
  console.log('\n✅ 镜像构建成功！');
  console.log('\n运行以下命令启动服务：');
  console.log('  docker compose up -d');
} catch (error) {
  console.error('\n❌ 构建失败');
  process.exit(1);
}

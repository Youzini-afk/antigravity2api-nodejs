import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { getMihomoPaths } from './mihomo_paths.js';

const NODE_URI_PATTERN = /^(ss|ssr|vmess|vless|trojan|hysteria|hysteria2|hy2|tuic|wireguard):\/\//i;

function normalizeProfileName(name) {
  return String(name || 'default')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^\w\-.\u4e00-\u9fa5]/g, '_')
    .slice(0, 80) || 'default';
}

export function getProfilePath(name) {
  const { profilesDir } = getMihomoPaths();
  return path.join(profilesDir, `${normalizeProfileName(name)}.yaml`);
}

export async function readProfileYaml(name) {
  return fs.readFile(getProfilePath(name), 'utf8');
}

export function parseMihomoYaml(content) {
  const doc = YAML.parseDocument(content || '');
  if (doc.errors?.length) {
    throw new Error(doc.errors.map((error) => error.message).join('; '));
  }
  const data = doc.toJS({}) || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Mihomo 配置必须是 YAML 对象');
  }
  return data;
}

export function buildRuntimeConfig(profileContent, mihomoConfig, secret) {
  const data = parseMihomoYaml(profileContent);

  for (const key of [
    'port', 'socks-port', 'redir-port', 'tproxy-port', 'mixed-port',
    'allow-lan', 'bind-address', 'external-controller',
    'external-controller-tls', 'external-controller-unix',
    'external-controller-pipe', 'secret', 'tun', 'listeners'
  ]) {
    delete data[key];
  }

  data['mixed-port'] = mihomoConfig.mixedPort;
  data['allow-lan'] = false;
  data['external-controller'] = `${mihomoConfig.controllerHost}:${mihomoConfig.controllerPort}`;
  data.secret = secret;
  data.mode = data.mode || 'rule';

  if (!Array.isArray(data.rules) || data.rules.length === 0) {
    data.rules = ['MATCH,GLOBAL'];
  }

  if (!Array.isArray(data.proxies) && !data['proxy-providers']) {
    throw new Error('配置中缺少 proxies 或 proxy-providers');
  }

  return YAML.stringify(data, { lineWidth: 0 });
}

function isProbablyBase64(content) {
  const compact = String(content || '').replace(/\s+/g, '');
  return compact.length > 16 && /^[A-Za-z0-9+/=_-]+$/.test(compact) && compact.length % 4 !== 1;
}

function decodeBase64Subscription(content) {
  const compact = String(content || '').replace(/\s+/g, '');
  const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const decoded = Buffer.from(normalized, 'base64').toString('utf8').trim();
    if (decoded && decoded !== content && NODE_URI_PATTERN.test(decoded.split(/\r?\n/).find(Boolean) || decoded)) {
      return decoded;
    }
  } catch {
    // ignore
  }
  return null;
}

function extractNodeUris(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && NODE_URI_PATTERN.test(line));
}

export function buildFileProviderProfile(providerPath) {
  return YAML.stringify({
    'proxy-providers': {
      subscription: {
        type: 'file',
        path: providerPath,
        'health-check': {
          enable: true,
          interval: 600,
          url: 'https://www.gstatic.com/generate_204'
        }
      }
    },
    'proxy-groups': [
      {
        name: 'PROXY',
        type: 'select',
        use: ['subscription'],
        proxies: ['DIRECT']
      },
      {
        name: 'Auto',
        type: 'url-test',
        use: ['subscription'],
        url: 'https://www.gstatic.com/generate_204',
        interval: 300
      }
    ],
    rules: ['MATCH,PROXY']
  }, { lineWidth: 0 });
}

function buildProviderProfileFromRawSubscription(rawContent) {
  const decoded = isProbablyBase64(rawContent) ? decodeBase64Subscription(rawContent) : null;
  const uriContent = decoded || rawContent;
  const nodeUris = extractNodeUris(uriContent);
  if (!nodeUris.length) return null;

  throw new Error('当前内容是 URI/Base64 节点订阅，请使用 URL 导入');
}

export function normalizeProfileContent(content) {
  const raw = String(content || '').trim();
  if (!raw) throw new Error('订阅内容为空');

  try {
    buildRuntimeConfig(raw, {
      mixedPort: 7897,
      controllerHost: '127.0.0.1',
      controllerPort: 9097
    }, 'validation');
    return { content: raw, format: 'yaml' };
  } catch (yamlError) {
    const converted = buildProviderProfileFromRawSubscription(raw);
    if (converted) {
      buildRuntimeConfig(converted, {
        mixedPort: 7897,
        controllerHost: '127.0.0.1',
        controllerPort: 9097
      }, 'validation');
      return { content: converted, format: 'uri' };
    }
    throw yamlError;
  }
}

export async function writeRuntimeConfig(profileName, mihomoConfig, secret) {
  const { runtimeConfigPath } = getMihomoPaths();
  const profileContent = await readProfileYaml(profileName);
  const runtimeYaml = buildRuntimeConfig(profileContent, mihomoConfig, secret);
  await fs.writeFile(runtimeConfigPath, runtimeYaml, 'utf8');
  return runtimeConfigPath;
}

export async function saveProfile({ name, content, source = 'local', url = '' }) {
  const safeName = normalizeProfileName(name);
  const normalized = normalizeProfileContent(content);

  const filePath = getProfilePath(safeName);
  await fs.writeFile(filePath, normalized.content, 'utf8');
  return {
    name: safeName,
    source: normalized.format === 'yaml' ? source : `${source}:${normalized.format}`,
    url,
    filePath,
    updatedAt: new Date().toISOString()
  };
}

export { normalizeProfileName };

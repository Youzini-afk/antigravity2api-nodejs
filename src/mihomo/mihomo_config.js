import fs from 'fs/promises';
import path from 'path';
import YAML from 'yaml';
import { getMihomoPaths } from './mihomo_paths.js';

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

export async function writeRuntimeConfig(profileName, mihomoConfig, secret) {
  const { runtimeConfigPath } = getMihomoPaths();
  const profileContent = await readProfileYaml(profileName);
  const runtimeYaml = buildRuntimeConfig(profileContent, mihomoConfig, secret);
  await fs.writeFile(runtimeConfigPath, runtimeYaml, 'utf8');
  return runtimeConfigPath;
}

export async function saveProfile({ name, content, source = 'local', url = '' }) {
  const safeName = normalizeProfileName(name);
  buildRuntimeConfig(content, {
    mixedPort: 7897,
    controllerHost: '127.0.0.1',
    controllerPort: 9097
  }, 'validation');

  const filePath = getProfilePath(safeName);
  await fs.writeFile(filePath, content, 'utf8');
  return {
    name: safeName,
    source,
    url,
    filePath,
    updatedAt: new Date().toISOString()
  };
}

export { normalizeProfileName };

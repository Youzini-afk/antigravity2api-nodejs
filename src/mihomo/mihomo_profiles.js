import fs from 'fs/promises';
import dns from 'dns/promises';
import net from 'net';
import { saveProfile, normalizeProfileName } from './mihomo_config.js';
import { patchMihomoState, readMihomoState } from './mihomo_state.js';

function assertSafeSubscriptionUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('订阅 URL 格式无效');
  }

  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new Error('订阅 URL 仅支持 http/https');
  }
  return parsed;
}

function isPrivateAddress(address) {
  if (!address) return true;
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      address === '0.0.0.0';
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:');
  }
  return true;
}

async function assertPublicHostname(parsedUrl) {
  const hostname = parsedUrl.hostname;
  if (hostname === 'metadata.google.internal') {
    throw new Error('订阅 URL 不允许访问云元数据地址');
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('订阅 URL 不允许访问内网/本机地址');
    return;
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error('订阅 URL 解析到内网/本机地址，已拒绝');
  }
}

async function fetchTextWithLimit(url, { timeoutMs, maxBytes }) {
  const parsedUrl = assertSafeSubscriptionUrl(url);
  await assertPublicHostname(parsedUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'antigravity2api-mihomo/1.0'
      },
      redirect: 'error'
    });

    if (!response.ok) {
      throw new Error(`订阅下载失败: HTTP ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) return response.text();

    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`订阅内容超过限制 (${maxBytes} bytes)`);
      }
      chunks.push(value);
    }

    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

async function upsertProfileMeta(profileMeta) {
  const state = await readMihomoState();
  const profiles = state.profiles.filter((item) => item.name !== profileMeta.name);
  profiles.unshift(profileMeta);
  await patchMihomoState({
    profiles,
    currentProfile: profileMeta.name,
    lastError: ''
  });
  return profileMeta;
}

export async function importProfileFromUrl({ name, url, mihomoConfig }) {
  const parsed = assertSafeSubscriptionUrl(url);
  const content = await fetchTextWithLimit(parsed.toString(), {
    timeoutMs: mihomoConfig.downloadTimeoutMs,
    maxBytes: mihomoConfig.maxSubscriptionSizeBytes
  });
  const profile = await saveProfile({
    name: normalizeProfileName(name || parsed.hostname || 'subscription'),
    content,
    source: 'url',
    url: parsed.toString()
  });
  return upsertProfileMeta(profile);
}

export async function importProfileFromYaml({ name, content }) {
  const profile = await saveProfile({
    name: normalizeProfileName(name || 'local'),
    content,
    source: 'local',
    url: ''
  });
  return upsertProfileMeta(profile);
}

export async function listProfiles() {
  const state = await readMihomoState();
  return {
    currentProfile: state.currentProfile,
    profiles: state.profiles
  };
}

export async function removeProfile(name) {
  const safeName = normalizeProfileName(name);
  const state = await readMihomoState();
  const target = state.profiles.find((item) => item.name === safeName);
  if (target?.filePath) {
    await fs.unlink(target.filePath).catch(() => {});
  }
  const profiles = state.profiles.filter((item) => item.name !== safeName);
  await patchMihomoState({
    profiles,
    currentProfile: state.currentProfile === safeName ? (profiles[0]?.name || 'default') : state.currentProfile
  });
}

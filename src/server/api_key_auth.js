function toFirstTrimmedString(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first.trim() : '';
}

function addCandidate(target, value) {
  const key = toFirstTrimmedString(value);
  if (!key) return;
  if (!target.includes(key)) {
    target.push(key);
  }
}

function extractHeaderCandidates(headers = {}) {
  const candidates = [];
  const authHeader = toFirstTrimmedString(headers.authorization);
  const xApiKey = toFirstTrimmedString(headers['x-api-key']);
  const xGoogApiKey = toFirstTrimmedString(headers['x-goog-api-key']);

  if (authHeader) {
    const hasBearerPrefix = authHeader.toLowerCase().startsWith('bearer ');
    if (hasBearerPrefix) {
      const bearerKey = authHeader.slice(7).trim();
      addCandidate(candidates, bearerKey);
    } else {
      addCandidate(candidates, authHeader);
    }
  }

  addCandidate(candidates, xApiKey);
  addCandidate(candidates, xGoogApiKey);
  return candidates;
}

function extractQueryCandidates(query = {}) {
  const candidates = [];
  addCandidate(candidates, query?.key);
  return candidates;
}

export function extractApiKeyCandidates(pathname, headers = {}, query = {}) {
  const path = typeof pathname === 'string' ? pathname : '';
  const headerCandidates = extractHeaderCandidates(headers);
  const queryCandidates = extractQueryCandidates(query);

  // v1beta 系列优先使用 query/key 与 x-goog-api-key，同时兼容 Authorization/x-api-key
  if (path.startsWith('/v1beta/') || path.startsWith('/cli/v1beta/')) {
    return [...queryCandidates, ...headerCandidates].filter((value, index, arr) => arr.indexOf(value) === index);
  }

  return [...headerCandidates, ...queryCandidates].filter((value, index, arr) => arr.indexOf(value) === index);
}

function normalizeBypassKeyList(list) {
  if (!Array.isArray(list)) return [];
  const normalized = [];
  const seen = new Set();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

export function resolveApiKeyAuth({
  pathname,
  headers,
  query,
  primaryApiKey,
  bypassApiKeys,
  unrestrictedApiKeys
}) {
  const primary = typeof primaryApiKey === 'string' ? primaryApiKey : '';
  const bypassList = normalizeBypassKeyList(bypassApiKeys);
  const unrestrictedList = normalizeBypassKeyList(unrestrictedApiKeys);
  const candidates = extractApiKeyCandidates(pathname, headers, query);
  const authRequired = Boolean(primary) || bypassList.length > 0 || unrestrictedList.length > 0;

  let keyType = null;
  // 按候选顺序判定（v1: header 优先, v1beta: query/x-goog-api-key 优先）。
  // 这样可避免同一请求同时携带主/特殊 key 时被“全局主 key 优先”误覆盖。
  for (const key of candidates) {
    if (primary && key === primary) {
      keyType = 'primary';
      break;
    }
    // 同一 key 若既是 primary 又在 bypass 列表中，上面的 primary 分支会优先命中
    if (key !== primary && bypassList.includes(key)) {
      keyType = 'bypass';
      break;
    }
    if (key !== primary && unrestrictedList.includes(key)) {
      keyType = 'unrestricted';
      break;
    }
  }

  return {
    authRequired,
    isAuthenticated: !authRequired || keyType !== null,
    isBypassThreshold: keyType === 'bypass' || keyType === 'unrestricted',
    isUnrestricted: keyType === 'unrestricted',
    keyType
  };
}

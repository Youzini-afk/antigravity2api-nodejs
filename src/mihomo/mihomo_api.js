export class MihomoApiError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'MihomoApiError';
    this.status = status;
  }
}

export default class MihomoApi {
  constructor({ controllerHost, controllerPort, secret }) {
    this.baseUrl = `http://${controllerHost}:${controllerPort}`;
    this.secret = secret || '';
    this.timeoutMs = 5000;
  }

  _headers(extra = {}) {
    return {
      ...(this.secret ? { Authorization: `Bearer ${this.secret}` } : {}),
      ...extra
    };
  }

  async request(pathname, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        ...options,
        signal: controller.signal,
        headers: this._headers(options.headers || {})
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const message = data?.message || data?.error || text || `Mihomo API 请求失败: ${response.status}`;
      throw new MihomoApiError(message, response.status);
    }

    return data;
  }

  getVersion() {
    return this.request('/version');
  }

  getProxies() {
    return this.request('/proxies');
  }

  selectProxy(groupName, proxyName) {
    return this.request(`/proxies/${encodeURIComponent(groupName)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: proxyName })
    });
  }

  testDelay(proxyName, url, timeout = 5000) {
    const params = new URLSearchParams({ url, timeout: String(timeout) });
    return this.request(`/proxies/${encodeURIComponent(proxyName)}/delay?${params}`);
  }
}

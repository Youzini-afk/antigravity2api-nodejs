import fs from 'fs';
import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import requesterManager from '../utils/requesterManager.js';
import config from '../config/config.js';
import { resolveMihomoBinaryPath, getMihomoPaths } from './mihomo_paths.js';
import { generateMihomoSecret, patchMihomoState, readMihomoState } from './mihomo_state.js';
import { writeRuntimeConfig } from './mihomo_config.js';
import MihomoApi from './mihomo_api.js';

class MihomoManager {
  constructor() {
    this.proc = null;
    this.logs = [];
    this.secret = '';
    this.startedAt = null;
    this.lifecyclePromise = null;
    this.proxyActive = false;
    this.stopping = false;
  }

  _runExclusive(task) {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    this.lifecyclePromise = Promise.resolve()
      .then(task)
      .finally(() => {
        this.lifecyclePromise = null;
      });
    return this.lifecyclePromise;
  }

  getApi() {
    return new MihomoApi({
      controllerHost: config.mihomo.controllerHost,
      controllerPort: config.mihomo.controllerPort,
      secret: this.getSecret()
    });
  }

  getSecret() {
    if (config.mihomo.secret) return config.mihomo.secret;
    if (!this.secret) this.secret = generateMihomoSecret();
    return this.secret;
  }

  resetSecretCache() {
    this.secret = '';
  }

  applyProjectProxy() {
    if (config.mihomo.enabled && config.mihomo.setAsProjectProxy && this.isRunning()) {
      config.proxy = `http://127.0.0.1:${config.mihomo.mixedPort}`;
      this.proxyActive = true;
    } else {
      config.proxy = config.configuredProxy || null;
      this.proxyActive = false;
    }
    requesterManager.reload();
  }

  _pushLog(chunk) {
    const lines = String(chunk || '').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      this.logs.push({ time: new Date().toISOString(), line });
      if (this.logs.length > 200) this.logs.shift();
      logger.debug(`[mihomo] ${line}`);
    }
  }

  isRunning() {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null;
  }

  async start(options = {}) {
    return this._runExclusive(() => this._startInternal(options));
  }

  async _startInternal(options = {}) {
    if (this.isRunning()) return this.getStatus();

    const mihomoConfig = config.mihomo;
    const profileName = options.profile || mihomoConfig.profile;
    const secret = this.getSecret();
    const binPath = resolveMihomoBinaryPath(mihomoConfig.binPath);
    if (!binPath || !fs.existsSync(binPath)) {
      throw new Error(`Mihomo 核心不存在: ${binPath || 'unsupported platform'}`);
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(binPath, 0o755); } catch {}
    }

    const { rootDir } = getMihomoPaths();
    const runtimeConfigPath = await writeRuntimeConfig(profileName, mihomoConfig, secret);

    this.proc = spawn(binPath, [
      '-d', rootDir,
      '-f', runtimeConfigPath,
      '-secret', secret,
      '-ext-ctl', `${mihomoConfig.controllerHost}:${mihomoConfig.controllerPort}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    this.startedAt = new Date().toISOString();
    this.proc.stdout?.on('data', (chunk) => this._pushLog(chunk));
    this.proc.stderr?.on('data', (chunk) => this._pushLog(chunk));
    this.proc.on('exit', (code, signal) => {
      logger.warn(`Mihomo 已退出: code=${code}, signal=${signal}`);
      this.proc = null;
      if (!this.stopping) {
        this.applyProjectProxy();
      }
    });
    this.proc.on('error', (error) => {
      logger.error(`Mihomo 启动错误: ${error.message}`);
    });

    await this.waitReady(mihomoConfig.startupTimeoutMs);
    await patchMihomoState({
      currentProfile: profileName,
      lastStartedAt: this.startedAt,
      lastError: ''
    });
    await this.restoreSelectedProxies();
    this.applyProjectProxy();
    logger.info(`Mihomo 已启动: 127.0.0.1:${mihomoConfig.mixedPort}`);
    return this.getStatus();
  }

  async waitReady(timeoutMs) {
    const started = Date.now();
    const api = this.getApi();
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      if (!this.isRunning()) break;
      try {
        await api.getVersion();
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    await this._stopInternal({ reloadRequester: false });
    const message = lastError?.message || 'Mihomo 控制端口未就绪';
    await patchMihomoState({ lastError: message });
    throw new Error(`Mihomo 启动超时: ${message}`);
  }

  async stop() {
    return this._runExclusive(() => this._stopInternal());
  }

  async _stopInternal({ reloadRequester = true } = {}) {
    if (!this.proc) {
      if (reloadRequester) this.applyProjectProxy();
      return;
    }
    const proc = this.proc;
    this.proc = null;
    this.stopping = true;
    try {
      proc.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          resolve();
        }, 3000);
        proc.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      this.stopping = false;
    }
    if (reloadRequester) this.applyProjectProxy();
  }

  async restart(options = {}) {
    return this._runExclusive(async () => {
      await this._stopInternal();
      this.resetSecretCache();
      return this._startInternal(options);
    });
  }

  async restoreSelectedProxies() {
    const state = await readMihomoState();
    const selected = state.selected || {};
    const entries = Object.entries(selected).filter(([group, name]) => group && name);
    if (!entries.length) return;

    const api = this.getApi();
    for (const [group, name] of entries) {
      try {
        await api.selectProxy(group, name);
      } catch (error) {
        logger.debug(`恢复 Mihomo 节点选择失败 ${group} -> ${name}: ${error.message}`);
      }
    }
  }

  async onConfigUpdated(previousMihomoConfig = {}) {
    if (!config.mihomo.enabled) {
      await this.stop();
      this.applyProjectProxy();
      return this.getStatus();
    }

    const restartKeys = [
      'mixedPort', 'controllerHost', 'controllerPort', 'secret',
      'profile', 'binPath', 'startupTimeoutMs'
    ];
    const needsRestart = this.isRunning() && restartKeys.some((key) =>
      previousMihomoConfig?.[key] !== config.mihomo?.[key]
    );

    if (needsRestart) {
      return this.restart();
    }

    if (config.mihomo.enabled && config.mihomo.autoStart && !this.isRunning()) {
      return this.start();
    }

    this.applyProjectProxy();
    return this.getStatus();
  }

  async getStatus() {
    const state = await readMihomoState();
    return {
      enabled: config.mihomo.enabled,
      autoStart: config.mihomo.autoStart,
      setAsProjectProxy: config.mihomo.setAsProjectProxy,
      proxyActive: this.proxyActive,
      running: this.isRunning(),
      pid: this.proc?.pid || null,
      startedAt: this.startedAt,
      mixedPort: config.mihomo.mixedPort,
      controller: `${config.mihomo.controllerHost}:${config.mihomo.controllerPort}`,
      projectProxy: config.mihomo.enabled && config.mihomo.setAsProjectProxy
        ? `http://127.0.0.1:${config.mihomo.mixedPort}`
        : config.configuredProxy,
      currentProfile: state.currentProfile,
      profiles: state.profiles,
      selected: state.selected,
      lastError: state.lastError,
      logs: this.logs.slice(-50)
    };
  }

  async autoStart() {
    if (!config.mihomo.enabled || !config.mihomo.autoStart) return;
    try {
      await this.start();
    } catch (error) {
      logger.warn(`Mihomo 自动启动失败: ${error.message}`);
    }
  }
}

const mihomoManager = new MihomoManager();
export default mihomoManager;

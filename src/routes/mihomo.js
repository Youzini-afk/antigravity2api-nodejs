import express from 'express';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import { deepMerge } from '../utils/deepMerge.js';
import { reloadConfig } from '../utils/configReloader.js';
import mihomoManager from '../mihomo/mihomo_manager.js';
import { importProfileFromUrl, importProfileFromYaml, listProfiles, removeProfile } from '../mihomo/mihomo_profiles.js';
import { patchMihomoState, readMihomoState } from '../mihomo/mihomo_state.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    res.json({ success: true, data: await mihomoManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/config', async (req, res) => {
  try {
    const previousMihomoConfig = { ...config.mihomo };
    saveConfigJson(deepMerge(getConfigJson(), { mihomo: req.body || {} }));
    reloadConfig();
    const status = await mihomoManager.onConfigUpdated(previousMihomoConfig);
    res.json({ success: true, data: { config: config.mihomo, status } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/start', async (req, res) => {
  try {
    if (!config.mihomo.enabled) {
      saveConfigJson(deepMerge(getConfigJson(), { mihomo: { enabled: true } }));
      reloadConfig();
    }
    res.json({ success: true, data: await mihomoManager.start(req.body || {}) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/stop', async (req, res) => {
  try {
    await mihomoManager.stop();
    res.json({ success: true, data: await mihomoManager.getStatus() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/restart', async (req, res) => {
  try {
    const nextProfile = typeof req.body?.profile === 'string' ? req.body.profile.trim() : '';
    const updates = { enabled: true };
    if (nextProfile) updates.profile = nextProfile;
    saveConfigJson(deepMerge(getConfigJson(), { mihomo: updates }));
    reloadConfig();
    res.json({ success: true, data: await mihomoManager.restart(req.body || {}) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/profiles', async (req, res) => {
  try {
    res.json({ success: true, data: await listProfiles() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/profiles/import-url', async (req, res) => {
  try {
    const previousMihomoConfig = { ...config.mihomo };
    const profile = await importProfileFromUrl({
      name: req.body?.name,
      url: req.body?.url,
      mihomoConfig: config.mihomo
    });
    saveConfigJson(deepMerge(getConfigJson(), { mihomo: { profile: profile.name } }));
    reloadConfig();
    const status = await mihomoManager.onConfigUpdated(previousMihomoConfig);
    res.json({ success: true, data: { profile, status } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post('/profiles/import-yaml', async (req, res) => {
  try {
    const previousMihomoConfig = { ...config.mihomo };
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (Buffer.byteLength(content, 'utf8') > config.mihomo.maxSubscriptionSizeBytes) {
      return res.status(413).json({ success: false, message: 'YAML 内容超过大小限制' });
    }
    const profile = await importProfileFromYaml({
      name: req.body?.name,
      content
    });
    saveConfigJson(deepMerge(getConfigJson(), { mihomo: { profile: profile.name } }));
    reloadConfig();
    const status = await mihomoManager.onConfigUpdated(previousMihomoConfig);
    res.json({ success: true, data: { profile, status } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

router.delete('/profiles/:name', async (req, res) => {
  try {
    if (config.mihomo.profile === req.params.name) {
      return res.status(400).json({ success: false, message: '当前 Profile 不能删除，请先切换到其他 Profile' });
    }
    await removeProfile(req.params.name);
    res.json({ success: true, data: await listProfiles() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/proxies', async (req, res) => {
  try {
    const data = await mihomoManager.getApi().getProxies();
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.put('/proxies/:group', async (req, res) => {
  try {
    const group = req.params.group;
    const name = req.body?.name;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: '节点名称必填' });
    }
    await mihomoManager.getApi().selectProxy(group, name);
    const state = await readMihomoState();
    await patchMihomoState({ selected: { ...state.selected, [group]: name } });
    res.json({ success: true, data: { group, name } });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

router.get('/proxies/:name/delay', async (req, res) => {
  try {
    const data = await mihomoManager.getApi().testDelay(
      req.params.name,
      req.query.url || config.mihomo.healthCheckUrl,
      Number(req.query.timeout) || 5000
    );
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message });
  }
});

export default router;

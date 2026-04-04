import config, { getConfigJson, buildConfig } from '../config/config.js';
import requesterManager from './requesterManager.js';

/**
 * 重新加载配置到 config 对象
 * 同时重置请求器，使新的 useNativeAxios / proxy / timeout 配置生效
 */
export function reloadConfig() {
  const newConfig = buildConfig(getConfigJson());
  Object.assign(config, newConfig);
  requesterManager.reload();
}

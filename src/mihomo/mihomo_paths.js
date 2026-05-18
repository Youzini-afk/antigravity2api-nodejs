import fs from 'fs';
import path from 'path';
import { getBinDir, getMihomoDir } from '../utils/paths.js';

export function getMihomoPaths() {
  const rootDir = getMihomoDir();
  const profilesDir = path.join(rootDir, 'profiles');
  const runtimeDir = path.join(rootDir, 'runtime');

  for (const dir of [rootDir, profilesDir, runtimeDir]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  return {
    rootDir,
    profilesDir,
    runtimeDir,
    statePath: path.join(rootDir, 'state.json'),
    runtimeConfigPath: path.join(runtimeDir, 'mihomo.yaml')
  };
}

export function getDefaultMihomoBinaryName() {
  const platformMap = {
    win32: 'windows',
    linux: 'linux',
    darwin: 'darwin'
  };
  const archMap = {
    x64: 'amd64',
    arm64: 'arm64'
  };

  const osName = platformMap[process.platform];
  const archName = archMap[process.arch];
  if (!osName || !archName) return null;

  const ext = process.platform === 'win32' ? '.exe' : '';
  return `mihomo-${osName}-${archName}${ext}`;
}

export function resolveMihomoBinaryPath(configuredPath = '') {
  if (configuredPath) return configuredPath;

  const binName = getDefaultMihomoBinaryName();
  if (!binName) return null;

  const candidates = [
    path.join(getBinDir(), binName),
    path.join(getMihomoDir(), 'bin', binName)
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

import fs from 'fs/promises';
import { randomBytes } from 'crypto';
import { getMihomoPaths } from './mihomo_paths.js';

const DEFAULT_STATE = Object.freeze({
  profiles: [],
  currentProfile: 'default',
  selected: {},
  lastStartedAt: null,
  lastError: ''
});

export async function readMihomoState() {
  const { statePath } = getMihomoPaths();
  try {
    const raw = await fs.readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      selected: parsed.selected && typeof parsed.selected === 'object' ? parsed.selected : {}
    };
  } catch {
    return { ...DEFAULT_STATE, selected: {}, profiles: [] };
  }
}

export async function writeMihomoState(nextState) {
  const { statePath } = getMihomoPaths();
  const state = {
    ...DEFAULT_STATE,
    ...nextState,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export async function patchMihomoState(patch) {
  const current = await readMihomoState();
  return writeMihomoState({ ...current, ...patch });
}

export function generateMihomoSecret() {
  return randomBytes(24).toString('hex');
}

import assert from 'assert';
import geminicliTokenManager from '../src/auth/geminicli_token_manager.js';

async function run() {
  const manager = geminicliTokenManager;
  const originals = {
    storeReadAll: manager.store.readAll,
    storeWriteAll: manager.store.writeAll,
    storeGetSalt: manager.store.getSalt,
    reload: manager.reload,
    repairTokenLifecycle: manager._repairTokenLifecycle,
  };

  let storedTokens = [];

  try {
    manager.store.readAll = async () => storedTokens;
    manager.store.writeAll = async (tokens) => {
      storedTokens = tokens.map((token) => ({ ...token }));
    };
    manager.store.getSalt = async () => 'test-salt';
    manager.reload = async () => {};
    manager._repairTokenLifecycle = async (token, { incrementRepairCount = false } = {}) => {
      if (incrementRepairCount) {
        token.repairCount = (token.repairCount || 0) + 1;
      }
      token.lastAttemptAt = Date.now();
      if (token.email === 'pending@example.com') {
        token.status = 'pending';
        token.pendingStage = 'project_id';
        token.lastError = '无法获取 projectId';
        token.previewCapability = 'unknown';
        return { ok: false, status: 'pending', token };
      }

      token.status = 'ready';
      token.pendingStage = null;
      token.lastError = null;
      token.projectId = token.projectId || 'proj-ready';
      token.tier = token.tier || 'pro';
      token.previewCapability = token.previewCapability || 'supported';
      return { ok: true, status: 'ready', token };
    };

    const readyResult = await manager.addToken({
      token: 'access-1',
      refreshToken: 'refresh-1',
      expiry: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      email: 'ready@example.com',
      project_id: 'proj-import',
      preview: true
    }, { reload: false, attemptRepair: true, source: 'import' });

    assert.strictEqual(readyResult.success, true);
    assert.strictEqual(readyResult.data.status, 'ready');
    assert.strictEqual(storedTokens[0].projectId, 'proj-import');
    assert.strictEqual(storedTokens[0].previewCapability, 'supported');
    assert.ok(storedTokens[0].expires_in > 0);

    const pendingResult = await manager.addToken({
      access_token: 'access-2',
      refresh_token: 'refresh-2',
      email: 'pending@example.com'
    }, { reload: false, attemptRepair: true, source: 'oauth' });

    assert.strictEqual(pendingResult.success, true);
    assert.strictEqual(pendingResult.data.status, 'pending');
    assert.strictEqual(storedTokens[1].pendingStage, 'project_id');
    assert.strictEqual(storedTokens[1].lastError, '无法获取 projectId');

    console.log('✅ geminicli lifecycle tests passed');
  } finally {
    manager.store.readAll = originals.storeReadAll;
    manager.store.writeAll = originals.storeWriteAll;
    manager.store.getSalt = originals.storeGetSalt;
    manager.reload = originals.reload;
    manager._repairTokenLifecycle = originals.repairTokenLifecycle;
  }
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});

import assert from 'assert';
import tokenManager from '../src/auth/token_manager.js';
import geminicliTokenManager from '../src/auth/geminicli_token_manager.js';

async function run() {
  const token = { refresh_token: 'test-refresh-token-request-count' };

  tokenManager.tokenRequestCounts.delete(token.refresh_token);
  await tokenManager.recordRequest(token, null);
  await tokenManager.recordRequest(token, null);
  assert.strictEqual(tokenManager.tokenRequestCounts.get(token.refresh_token), 2);

  geminicliTokenManager.tokenRequestCounts.delete(token.refresh_token);
  await geminicliTokenManager.recordRequest(token, null);
  await geminicliTokenManager.recordRequest(token, null);
  assert.strictEqual(geminicliTokenManager.tokenRequestCounts.get(token.refresh_token), 2);

  console.log('✅ request count recording tests passed');
}

run().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
});

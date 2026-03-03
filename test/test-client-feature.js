import { sendClientFeature } from "../src/api/client.js";
import tokenManager from "../src/auth/token_manager.js";

try {
  const token = await tokenManager.getToken();
  if (!token) {
    console.warn("SKIP: 无可用 token，跳过 client feature 上游联调测试");
    process.exit(0);
  }

  await sendClientFeature(token);
  console.log("PASS: client feature 请求成功");
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}

import { serializeTelemetryBatch,createTelemetryBatch } from "../src/utils/createTelemetry.js";
import { sendLog } from "../src/api/client.js";
import tokenManager from "../src/auth/token_manager.js";

try {
  const token = await tokenManager.getToken();
  if (!token) {
    console.warn('SKIP: 无可用 token，跳过 telemetry 联调测试');
    process.exit(0);
  }

  const num = 1;
  const Logbody = createTelemetryBatch(num);
  console.log(JSON.stringify(Logbody, null, 2));
  const serializeData = serializeTelemetryBatch(Logbody);
  console.log(serializeData);
  await sendLog(token, num);
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}

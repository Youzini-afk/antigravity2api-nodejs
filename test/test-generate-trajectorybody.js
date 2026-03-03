import { generateTrajectorybody } from "../src/utils/trajectory.js";
import { QA_PAIRS } from "../src/constants/index.js";

if (!Array.isArray(QA_PAIRS) || QA_PAIRS.length === 0) {
  console.error("FAIL: QA_PAIRS 为空，无法生成轨迹测试数据");
  process.exit(1);
}

const trajectoryBody = generateTrajectorybody(0, `test-${Date.now()}`, "gemini-2.5-pro");
if (!trajectoryBody?.trajectory || !trajectoryBody?.metadata) {
  console.error("FAIL: generateTrajectorybody 返回结构不完整");
  process.exit(1);
}

console.log(JSON.stringify(trajectoryBody, null, 2));

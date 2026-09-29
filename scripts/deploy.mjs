// Deploy Worker rồi lưu địa chỉ Worker (WORKER_URL) vào .env để bước gắn MCP dùng.
import { spawnSync } from "node:child_process";
import { setEnv } from "./env.mjs";

const r = spawnSync("npx wrangler deploy", { shell: true, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] });
process.stdout.write(r.stdout ?? "");
process.stderr.write(r.stderr ?? "");
if (r.status !== 0) {
  console.error("\nDeploy lỗi. Đọc thông báo ở trên (README mục Lỗi thường gặp).");
  process.exit(r.status ?? 1);
}
const url = `${r.stdout}\n${r.stderr}`.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
if (url) {
  setEnv("WORKER_URL", url);
  console.log(`\nĐã lưu WORKER_URL=${url} vào .env. Bước tiếp theo: npm run secrets, rồi npm run gan-mcp.`);
} else {
  console.log("\nKhông đọc được địa chỉ Worker từ kết quả deploy — tự điền WORKER_URL vào .env (dạng https://meta-ads-mcp.<tên>.workers.dev).");
}

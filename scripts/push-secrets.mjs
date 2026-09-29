// Đẩy bí mật từ .env lên Worker (Cloudflare). Chỉ in TÊN các mục, không in giá trị.
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { readEnv, setEnv } from "./env.mjs";

const env = readEnv();

if (!env.META_ACCESS_TOKEN) {
  console.error("Thiếu META_ACCESS_TOKEN trong .env (README mục 2-3).");
  process.exit(1);
}
if (!env.META_ACCESS_TOKEN.startsWith("EAA")) {
  console.error("META_ACCESS_TOKEN trông không giống token Meta (token thật bắt đầu bằng EAA). Kiểm tra lại đã dán đúng chưa.");
  process.exit(1);
}
if (!env.MCP_AUTH_KEY) {
  env.MCP_AUTH_KEY = randomBytes(24).toString("hex");
  setEnv("MCP_AUTH_KEY", env.MCP_AUTH_KEY);
  console.log("Đã tạo khoá truy cập MCP mới (MCP_AUTH_KEY) và lưu vào .env");
}

const secrets = { META_ACCESS_TOKEN: env.META_ACCESS_TOKEN, MCP_AUTH_KEY: env.MCP_AUTH_KEY };
if (env.META_APP_SECRET) secrets.META_APP_SECRET = env.META_APP_SECRET;
else console.log("Lưu ý: chưa có META_APP_SECRET — vẫn chạy được, nhưng nên điền để tăng bảo mật.");

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
  secrets.SUPABASE_URL = env.SUPABASE_URL;
  secrets.SUPABASE_SERVICE_KEY = env.SUPABASE_SERVICE_KEY;
} else if (env.SUPABASE_URL || env.SUPABASE_SERVICE_KEY) {
  console.error("Supabase cần đủ cả SUPABASE_URL và SUPABASE_SERVICE_KEY (hoặc để trống cả hai nếu chưa dùng).");
  process.exit(1);
}

const file = join(tmpdir(), `meta-ads-secrets-${process.pid}.json`);
writeFileSync(file, JSON.stringify(secrets));
try {
  execSync(`npx wrangler secret bulk "${file}"`, { stdio: "inherit" });
  console.log(`\nĐã đẩy: ${Object.keys(secrets).join(", ")}${secrets.SUPABASE_URL ? "" : " (chưa có Supabase — phần tuỳ chọn)"}`);
} finally {
  rmSync(file, { force: true });
}

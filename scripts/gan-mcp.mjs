// Gắn MCP meta-ads vào Claude Code. Không in khoá ra màn hình.
//   npm run gan-mcp                    -> dùng lệnh `claude` (nếu có), gắn cho mọi thư mục (scope user)
//   npm run gan-mcp -- "D:\du-an"      -> ghi .mcp.json vào thư mục dự án (dùng cho Claude Code bản desktop)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { readEnv } from "./env.mjs";

const env = readEnv();
if (!env.WORKER_URL || !env.MCP_AUTH_KEY) {
  console.error("Thiếu WORKER_URL hoặc MCP_AUTH_KEY trong .env — chạy npm run secrets và npm run deploy trước.");
  process.exit(1);
}
const url = `${env.WORKER_URL.replace(/\/+$/, "")}/mcp`;
const header = `Authorization: Bearer ${env.MCP_AUTH_KEY}`;
const thuMuc = process.argv[2];

if (!thuMuc) {
  const coClaude = spawnSync("claude --version", { shell: true, encoding: "utf8" }).status === 0;
  if (coClaude) {
    spawnSync("claude mcp remove meta-ads --scope user", { shell: true, stdio: "ignore" });
    const r = spawnSync(`claude mcp add --transport http --scope user meta-ads ${url} --header "${header}"`,
      { shell: true, encoding: "utf8" });
    if (r.status === 0) {
      console.log("Đã gắn MCP meta-ads vào Claude Code (dùng được ở mọi thư mục). Mở lại phiên Claude Code để thấy công cụ.");
      process.exit(0);
    }
    console.error("Lệnh claude mcp add báo lỗi:\n" + (r.stderr || r.stdout).replaceAll(env.MCP_AUTH_KEY, "<khoá>"));
    process.exit(1);
  }
  console.error("Máy không có lệnh `claude` (thường gặp khi dùng Claude Code bản desktop).\n" +
    "Chạy lại kèm thư mục dự án bạn mở trong Claude Code, ví dụ:\n  npm run gan-mcp -- \"D:/Claude/du-an-cua-toi\"");
  process.exit(1);
}

const dich = resolve(thuMuc);
if (!existsSync(dich)) {
  console.error(`Không thấy thư mục ${dich}.`);
  process.exit(1);
}
const file = join(dich, ".mcp.json");
let cfg = { mcpServers: {} };
if (existsSync(file)) {
  try { cfg = JSON.parse(readFileSync(file, "utf8")); } catch { console.error(`${file} không phải JSON hợp lệ — sửa hoặc xoá file rồi chạy lại.`); process.exit(1); }
  cfg.mcpServers ??= {};
}
cfg.mcpServers["meta-ads"] = { type: "http", url, headers: { Authorization: `Bearer ${env.MCP_AUTH_KEY}` } };
writeFileSync(file, JSON.stringify(cfg, null, 2));
console.log(`Đã ghi MCP meta-ads vào ${file}.\n` +
  "Mở lại Claude Code ở thư mục này; nếu được hỏi có cho phép server 'meta-ads' không thì chọn Cho phép.\n" +
  "Lưu ý: file .mcp.json chứa khoá truy cập — đừng gửi file này cho người khác.");

// Đọc / ghi file .env ở thư mục gốc repo. Không bao giờ in giá trị bí mật ra màn hình.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export function readEnv() {
  if (!existsSync(ENV_PATH)) {
    console.error("Chưa có file .env. Sao chép .env.example thành .env rồi điền token (README mục 4).");
    process.exit(1);
  }
  return Object.fromEntries(
    readFileSync(ENV_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?(.*?)"?\s*$/))
      .filter(Boolean).map((m) => [m[1], m[2]]),
  );
}

/** Ghi (thêm hoặc thay) 1 dòng KEY=value trong .env, giữ nguyên các dòng khác. */
export function setEnv(key, value) {
  const text = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  const line = `${key}=${value}`;
  const re = new RegExp(`^\s*${key}\s*=.*$`, "m");
  writeFileSync(ENV_PATH, re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`);
}

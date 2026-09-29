import { Env, ToolError } from "./meta";

/** Supabase là phần tuỳ chọn: set quảng cáo không cần, chỉ báo cáo lịch sử + dashboard cần. */
export const supabaseReady = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);

export const SUPABASE_MISSING =
  "Chưa cài Supabase (phần tuỳ chọn) nên chưa có báo cáo lịch sử / dashboard. Dùng get_insights để xem số trực tiếp từ Meta, " +
  "hoặc làm mục 'Supabase (tuỳ chọn)' trong README rồi chạy lại npm run secrets.";

async function call(env: Env, path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  if (!supabaseReady(env)) throw new ToolError(SUPABASE_MISSING);
  const key = env.SUPABASE_SERVICE_KEY!;
  const resp = await fetch(`${env.SUPABASE_URL!.replace(/\/+$/, "")}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    const hint = /PGRST20[25]|does not exist/.test(text)
      ? " (Chưa tạo bảng? Chạy file supabase/schema.sql trong Supabase SQL Editor.)"
      : "";
    throw new ToolError(`Supabase lỗi ${resp.status} ở ${path.split("?")[0]}: ${text.slice(0, 400)}${hint}`);
  }
  return resp;
}

export async function upsert(env: Env, table: string, rows: any[], onConflict: string): Promise<number> {
  for (let i = 0; i < rows.length; i += 500) {
    await call(env, `${table}?on_conflict=${onConflict}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 500)),
    });
  }
  return rows.length;
}

export async function insert(env: Env, table: string, row: any): Promise<void> {
  await call(env, table, { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

export async function rpc(env: Env, fn: string, args: Record<string, unknown>): Promise<any> {
  const resp = await call(env, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
  return resp.json();
}

export async function select(env: Env, query: string): Promise<any[]> {
  const resp = await call(env, query, { method: "GET" });
  return resp.json();
}

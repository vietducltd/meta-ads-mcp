import page from "./dashboard.html";
import { Env, act } from "./meta";
import { SUPABASE_MISSING, rpc, select, supabaseReady } from "./supabase";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = new Set(["account", "campaign", "adset", "ad", "day"]);

/** /dash/<key>            -> trang dashboard
 *  /dash/<key>/api/accounts -> danh sách tài khoản + lần đồng bộ cuối
 *  /dash/<key>/api/report   -> meta_report(since, until, level, account) */
export async function handleDashboard(url: URL, env: Env): Promise<Response> {
  const rest = url.pathname.split("/").slice(3).filter(Boolean).join("/");
  if (!supabaseReady(env)) {
    return new Response(SUPABASE_MISSING, { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  try {
    if (!rest) {
      return new Response(page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Robots-Tag": "noindex",
        },
      });
    }
    if (rest === "api/accounts") {
      const [accounts, runs] = await Promise.all([
        select(env, "meta_ad_accounts?select=id,name,currency,timezone_name,account_status&order=name"),
        select(env, "meta_sync_runs?select=finished_at&ok=eq.true&order=finished_at.desc&limit=1"),
      ]);
      return Response.json({ accounts, last_sync: runs[0]?.finished_at ?? null });
    }
    if (rest === "api/report") {
      const q = url.searchParams;
      const since = q.get("since") ?? "", until = q.get("until") ?? "", level = q.get("level") ?? "campaign";
      if (!DATE.test(since) || !DATE.test(until) || !LEVELS.has(level)) {
        return Response.json({ error: "Tham số since/until/level không hợp lệ" }, { status: 400 });
      }
      const account = q.get("account");
      return Response.json(await rpc(env, "meta_report", {
        p_since: since, p_until: until, p_level: level, p_account: account ? act(account, env) : null,
      }));
    }
    return new Response("Not found", { status: 404 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

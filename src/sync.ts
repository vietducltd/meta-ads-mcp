import { ACCOUNT_STATUS, Env, Meta, ToolError, act, currencyOffset } from "./meta";
import { SUPABASE_MISSING, insert, supabaseReady, upsert } from "./supabase";

// Bỏ qua đối tượng đã lưu trữ / xoá để giảm số lần gọi API.
const LIVE_STATUSES = [
  "ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED", "IN_PROCESS", "WITH_ISSUES",
  "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED", "PENDING_BILLING_INFO",
];

const INSIGHT_FIELDS =
  "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency," +
  "clicks,inline_link_clicks,actions,action_values";

const num = (v: unknown) => (v === undefined || v === null || v === "" ? 0 : Number(v));
const ts = (v: unknown) => (v ? String(v) : null);

function pick(list: any[] | undefined, types: string[]): number {
  for (const type of types) {
    const hit = list?.find((a) => a.action_type === type);
    if (hit) return num(hit.value);
  }
  return 0;
}

const ymd = (date: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface SyncOptions {
  days?: number;
  since?: string;
  until?: string;
  /** Lùi mốc "until" bao nhiêu ngày so với hôm nay (0 = hôm nay). */
  offset?: number;
  /** false = chỉ kéo số liệu, bỏ qua campaign / ad set / ad. */
  structure?: boolean;
}

// Meta hay lỗi (code 1/2) khi 1 truy vấn insights quá nặng, nên chia lịch sử thành từng đợt.
const CHUNK_DAYS = 14;

/** Kéo cấu trúc + số liệu theo ngày của 1 tài khoản về Supabase. */
export async function syncAccount(env: Env, accountId: string, opts: SyncOptions, trigger: string) {
  const meta = new Meta(env);
  const account = act(accountId, env);
  const started = new Date().toISOString();
  try {
    const info = await meta.request("GET", account, {
      fields: "id,name,currency,timezone_name,account_status,amount_spent,balance",
    });
    const off = currencyOffset(info.currency);
    const money = (v: unknown) => (v === undefined || v === null || v === "" ? null : num(v) / off);

    const days = Math.min(Math.max(opts.days ?? Number(env.SYNC_DAYS || 3), 1), 93);
    const until = opts.until || addDays(ymd(new Date(), info.timezone_name), -(opts.offset ?? 0));
    const since = opts.since || addDays(until, 1 - days);

    const filter = { effective_status: LIVE_STATUSES };
    const withStructure = opts.structure !== false;
    const [campaigns, adsets, ads, insights] = await Promise.all([
      withStructure ? meta.getAll(`${account}/campaigns`, {
        ...filter,
        fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time,start_time,stop_time",
      }, 5000, 500) : [],
      withStructure ? meta.getAll(`${account}/adsets`, {
        ...filter,
        fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal," +
          "billing_event,destination_type,bid_strategy,targeting,start_time,end_time",
      }, 5000, 200) : [],
      withStructure ? meta.getAll(`${account}/ads`, {
        ...filter,
        fields: "id,name,campaign_id,adset_id,status,effective_status,creative{id},created_time",
      }, 5000, 500) : [],
      meta.getAll(`${account}/insights`, {
        level: "ad",
        time_increment: 1,
        time_range: { since, until },
        fields: INSIGHT_FIELDS,
      }, 20000, 250),
    ]);

    const now = new Date().toISOString();
    await upsert(env, "meta_ad_accounts", [{
      id: info.id, name: info.name, currency: info.currency, timezone_name: info.timezone_name,
      account_status: ACCOUNT_STATUS[info.account_status] ?? String(info.account_status),
      amount_spent: money(info.amount_spent), balance: money(info.balance), synced_at: now,
    }], "id");

    await upsert(env, "meta_campaigns", campaigns.map((c) => ({
      id: c.id, account_id: account, name: c.name, objective: c.objective, status: c.status,
      effective_status: c.effective_status, daily_budget: money(c.daily_budget), lifetime_budget: money(c.lifetime_budget),
      bid_strategy: c.bid_strategy ?? null, created_time: ts(c.created_time), start_time: ts(c.start_time),
      stop_time: ts(c.stop_time), synced_at: now,
    })), "id");

    await upsert(env, "meta_adsets", adsets.map((s) => ({
      id: s.id, account_id: account, campaign_id: s.campaign_id, name: s.name, status: s.status,
      effective_status: s.effective_status, daily_budget: money(s.daily_budget), lifetime_budget: money(s.lifetime_budget),
      optimization_goal: s.optimization_goal ?? null, billing_event: s.billing_event ?? null,
      destination_type: s.destination_type ?? null, bid_strategy: s.bid_strategy ?? null,
      targeting: s.targeting ?? null, start_time: ts(s.start_time), end_time: ts(s.end_time), synced_at: now,
    })), "id");

    await upsert(env, "meta_ads", ads.map((a) => ({
      id: a.id, account_id: account, campaign_id: a.campaign_id, adset_id: a.adset_id, name: a.name,
      status: a.status, effective_status: a.effective_status, creative_id: a.creative?.id ?? null,
      created_time: ts(a.created_time), synced_at: now,
    })), "id");

    await upsert(env, "meta_insights_daily", insights.map((r) => ({
      account_id: account, date: r.date_start, currency: info.currency,
      campaign_id: r.campaign_id, campaign_name: r.campaign_name,
      adset_id: r.adset_id, adset_name: r.adset_name, ad_id: r.ad_id, ad_name: r.ad_name,
      spend: num(r.spend), impressions: num(r.impressions), reach: num(r.reach), frequency: num(r.frequency),
      clicks: num(r.clicks), link_clicks: num(r.inline_link_clicks),
      landing_page_views: pick(r.actions, ["landing_page_view", "omni_landing_page_view"]),
      messages: pick(r.actions, ["onsite_conversion.messaging_conversation_started_7d"]),
      leads: pick(r.actions, ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]),
      add_to_cart: pick(r.actions, ["add_to_cart", "omni_add_to_cart", "offsite_conversion.fb_pixel_add_to_cart"]),
      initiate_checkout: pick(r.actions, [
        "initiate_checkout", "omni_initiated_checkout", "offsite_conversion.fb_pixel_initiate_checkout",
      ]),
      purchases: pick(r.actions, ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]),
      purchase_value: pick(r.action_values, ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]),
      actions: r.actions ?? null, action_values: r.action_values ?? null, synced_at: now,
    })), "ad_id,date");

    const detail = {
      name: info.name, since, until, campaigns: campaigns.length, adsets: adsets.length,
      ads: ads.length, insight_rows: insights.length,
    };
    await insert(env, "meta_sync_runs", {
      started_at: started, finished_at: new Date().toISOString(), trigger, account_id: account, ok: true, detail,
    });
    return { account, ok: true, ...detail };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await insert(env, "meta_sync_runs", {
      started_at: started, finished_at: new Date().toISOString(), trigger, account_id: account, ok: false,
      detail: { error },
    }).catch(() => {});
    if (e instanceof ToolError) return { account, ok: false, error };
    throw e;
  }
}

/** Tài khoản cần đồng bộ: SYNC_ACCOUNTS (cách nhau dấu phẩy) hoặc toàn bộ tài khoản token truy cập được. */
export async function accountsToSync(env: Env): Promise<string[]> {
  const listed = (env.SYNC_ACCOUNTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (listed.length) return listed.map((id) => act(id, env));
  const accounts = await new Meta(env).getAll("me/adaccounts", { fields: "id,account_status" }, 200);
  return accounts.filter((a) => a.account_status === 1).map((a) => a.id);
}

/** Chia khoảng thời gian cần đồng bộ thành các đợt ≤ CHUNK_DAYS ngày, đợt mới nhất trước. */
function chunks(env: Env, opts: SyncOptions): SyncOptions[] {
  const out: SyncOptions[] = [];
  if (opts.since && opts.until) {
    for (let end = opts.until; end >= opts.since; end = addDays(end, -CHUNK_DAYS)) {
      const start = addDays(end, 1 - CHUNK_DAYS);
      out.push({ since: start < opts.since ? opts.since : start, until: end });
    }
  } else {
    const days = Math.min(Math.max(opts.days ?? Number(env.SYNC_DAYS || 3), 1), 93);
    for (let offset = 0; offset < days; offset += CHUNK_DAYS) {
      out.push({ offset, days: Math.min(CHUNK_DAYS, days - offset) });
    }
  }
  return out.map((c, i) => ({ ...c, structure: i === 0 }));
}

/**
 * Mỗi (tài khoản × đợt) chạy trong 1 lần gọi Worker riêng qua service binding SELF, để không vượt
 * giới hạn subrequest / CPU của một lần chạy. Các tài khoản chạy song song, các đợt chạy lần lượt.
 */
export async function syncAll(env: Env, opts: SyncOptions, trigger: string, accounts?: string[]) {
  if (!supabaseReady(env)) throw new ToolError(SUPABASE_MISSING);
  const list = accounts?.length ? accounts.map((a) => act(a, env)) : await accountsToSync(env);
  const plan = chunks(env, opts);
  return Promise.all(list.map(async (account) => {
    const summary: any = { account, ok: true, since: null, until: null, campaigns: 0, adsets: 0, ads: 0, insight_rows: 0 };
    const errors: string[] = [];
    for (const chunk of plan) {
      const resp = await env.SELF.fetch("https://self/internal/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.MCP_AUTH_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ account, trigger, ...chunk }),
      });
      const text = await resp.text();
      let r: any;
      try {
        r = JSON.parse(text);
      } catch {
        r = { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }
      if (!r.ok) {
        errors.push(r.error);
        continue;
      }
      summary.name = r.name;
      if (!summary.since || r.since < summary.since) summary.since = r.since;
      if (!summary.until || r.until > summary.until) summary.until = r.until;
      for (const k of ["campaigns", "adsets", "ads", "insight_rows"]) summary[k] += r[k];
    }
    if (errors.length) Object.assign(summary, { ok: false, failed_chunks: errors.length, of: plan.length, errors });
    return summary;
  }));
}

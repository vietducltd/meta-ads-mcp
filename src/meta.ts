export interface Env {
  META_ACCESS_TOKEN: string;
  META_APP_SECRET?: string;
  META_API_VERSION?: string;
  DEFAULT_AD_ACCOUNT?: string;
  DEFAULT_PAGE_ID?: string;
  BUDGET_CAPS?: string;
  MCP_AUTH_KEY: string;
  /** Tuỳ chọn: chỉ cần cho báo cáo lịch sử (get_saved_report, sync_to_supabase) và dashboard. */
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  SYNC_ACCOUNTS?: string;
  SYNC_DAYS?: string;
  SELF: Fetcher;
}

/** Lỗi dự kiến: nội dung được trả nguyên văn cho Claude đọc. */
export class ToolError extends Error {}

// Meta tính ngân sách theo đơn vị nhỏ nhất; các tiền tệ này không có phần lẻ (offset 1).
const ZERO_DECIMAL = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);
export const currencyOffset = (currency: string) => (ZERO_DECIMAL.has(currency) ? 1 : 100);

export const ACCOUNT_STATUS: Record<number, string> = {
  1: "ACTIVE", 2: "DISABLED", 3: "UNSETTLED", 7: "PENDING_RISK_REVIEW", 8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD", 100: "PENDING_CLOSURE", 101: "CLOSED", 201: "ANY_ACTIVE", 202: "ANY_CLOSED",
};

export function act(accountId: string | undefined, env: Env): string {
  const id = (accountId || env.DEFAULT_AD_ACCOUNT || "").trim();
  if (!id) throw new ToolError("Thiếu account_id. Gọi list_ad_accounts để xem danh sách tài khoản.");
  return id.startsWith("act_") ? id : `act_${id}`;
}

function encode(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "object" ? JSON.stringify(value) : String(value);
  }
  return out;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export class Meta {
  private proofs = new Map<string, string>();
  private pageTokens = new Map<string, string>();
  private currencies = new Map<string, string>();

  constructor(private env: Env) {}

  get base() {
    return `https://graph.facebook.com/${this.env.META_API_VERSION || "v24.0"}`;
  }

  /** token mặc định là token người dùng trong secret; truyền page token khi API đòi token của Page. */
  private async auth(tokenOverride?: string): Promise<Record<string, string>> {
    const token = tokenOverride || this.env.META_ACCESS_TOKEN;
    if (!token) throw new ToolError("Worker chưa có secret META_ACCESS_TOKEN (chạy: npm run secrets).");
    const auth: Record<string, string> = { access_token: token };
    if (this.env.META_APP_SECRET) {
      let proof = this.proofs.get(token);
      if (!proof) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw", enc.encode(this.env.META_APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        proof = hex(await crypto.subtle.sign("HMAC", key, enc.encode(token)));
        this.proofs.set(token, proof);
      }
      auth.appsecret_proof = proof;
    }
    return auth;
  }

  /** Page access token (lấy từ token người dùng, cần quyền quản lý Page). */
  async pageToken(pageId: string): Promise<string> {
    let token = this.pageTokens.get(pageId);
    if (!token) {
      const body = await this.request("GET", pageId, { fields: "access_token" });
      token = body.access_token as string;
      if (!token) throw new ToolError(`Không lấy được page token của ${pageId} — token hiện tại có quản lý Page này không?`);
      this.pageTokens.set(pageId, token);
    }
    return token;
  }

  async request<T = any>(
    method: "GET" | "POST",
    path: string,
    params: Record<string, unknown> = {},
    file?: { field: string; blob: Blob; filename: string },
    retried = false,
    tokenOverride?: string,
  ): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${this.base}/${path.replace(/^\//, "")}`);
    const payload = { ...encode(params), ...(await this.auth(tokenOverride)) };
    let resp: Response;
    try {
      if (method === "GET") {
        for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, v);
        resp = await fetch(url);
      } else if (file) {
        const form = new FormData();
        for (const [k, v] of Object.entries(payload)) form.set(k, v);
        form.set(file.field, file.blob, file.filename);
        resp = await fetch(url, { method: "POST", body: form });
      } else {
        resp = await fetch(url, { method: "POST", body: new URLSearchParams(payload) });
      }
    } catch (e) {
      throw new ToolError(`Không kết nối được Meta API: ${e}`);
    }
    const text = await resp.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ToolError(`Meta API HTTP ${resp.status}: ${text.slice(0, 500)}`);
    }
    if (body?.error) {
      const err = body.error;
      // code 1 / 2 là lỗi tạm thời phía Meta (thường do truy vấn nặng): thử lại 1 lần với GET
      if (method === "GET" && [1, 2].includes(err.code) && !retried) {
        await new Promise((r) => setTimeout(r, 1500));
        return this.request(method, path, params, file, true, tokenOverride);
      }
      throw new ToolError(
        `Meta API lỗi (code ${err.code}, subcode ${err.error_subcode ?? "-"}): ` +
          `${err.error_user_msg || err.message} [fbtrace_id=${err.fbtrace_id}]`,
      );
    }
    return body as T;
  }

  /** Tự lật trang cho tới khi đủ `limit` bản ghi. */
  async getAll(path: string, params: Record<string, unknown>, limit: number, pageSize = 100): Promise<any[]> {
    let body = await this.request("GET", path, { ...params, limit: Math.min(limit, pageSize) });
    const items: any[] = [...(body.data ?? [])];
    while (items.length < limit && body.paging?.next) {
      body = await this.request("GET", body.paging.next);
      items.push(...(body.data ?? []));
    }
    return items.slice(0, limit);
  }

  /** Tiền tệ của tài khoản chứa đối tượng (act_..., campaign, adset hoặc ad). */
  async currencyOf(objectId: string): Promise<{ account: string; currency: string }> {
    let account = objectId;
    if (!objectId.startsWith("act_")) {
      const obj = await this.request("GET", objectId, { fields: "account_id" });
      account = `act_${obj.account_id}`;
    }
    let currency = this.currencies.get(account);
    if (!currency) {
      currency = (await this.request("GET", account, { fields: "currency" })).currency as string;
      this.currencies.set(account, currency);
    }
    return { account, currency };
  }

  /**
   * Đổi ngân sách người dùng nhập (đơn vị thường: VND = đồng, USD = đô) sang đơn vị nhỏ nhất Meta yêu cầu,
   * đồng thời chặn nếu vượt BUDGET_CAPS.
   */
  async budget(objectId: string, daily?: number, lifetime?: number): Promise<{ daily?: number; lifetime?: number }> {
    if (!daily && !lifetime) return {};
    const { currency } = await this.currencyOf(objectId);
    const caps = JSON.parse(this.env.BUDGET_CAPS || "{}");
    const cap = caps[currency] ?? caps["*"];
    if (!cap) {
      throw new ToolError(`Chưa đặt giới hạn ngân sách cho tiền tệ ${currency} trong BUDGET_CAPS nên không cho đặt ngân sách.`);
    }
    if (daily && cap.daily && daily > cap.daily) {
      throw new ToolError(`Ngân sách ngày ${daily.toLocaleString()} ${currency} vượt giới hạn an toàn ${cap.daily.toLocaleString()} ${currency}.`);
    }
    if (lifetime && cap.lifetime && lifetime > cap.lifetime) {
      throw new ToolError(`Ngân sách trọn đời ${lifetime.toLocaleString()} ${currency} vượt giới hạn an toàn ${cap.lifetime.toLocaleString()} ${currency}.`);
    }
    const off = currencyOffset(currency);
    return {
      daily: daily ? Math.round(daily * off) : undefined,
      lifetime: lifetime ? Math.round(lifetime * off) : undefined,
    };
  }
}

export function checkStatus(status: string): string {
  const s = status.toUpperCase();
  if (!["ACTIVE", "PAUSED", "ARCHIVED"].includes(s)) throw new ToolError("status chỉ nhận ACTIVE, PAUSED hoặc ARCHIVED.");
  return s;
}

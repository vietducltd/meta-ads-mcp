import { ACCOUNT_STATUS, Env, Meta, ToolError, act, checkStatus, currencyOffset } from "./meta";
import { rpc } from "./supabase";
import { syncAll } from "./sync";

type Args = Record<string, any>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: Args, env: Env, meta: Meta) => Promise<unknown>;
}

const str = (description: string) => ({ type: "string", description });
const int = (description: string, dflt?: number) => ({ type: "integer", description, ...(dflt !== undefined && { default: dflt }) });
const money = (description: string) => ({ type: "number", description });
const strList = (description: string) => ({ type: "array", items: { type: "string" }, description });
const obj = (description: string) => ({ type: "object", description, additionalProperties: true });

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const CONTROL = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

const ACCOUNT = str("ID tài khoản quảng cáo dạng act_123... (xem list_ad_accounts).");
const STATUS_FILTER = strList('Lọc theo effective_status, vd ["ACTIVE"] hoặc ["ACTIVE","PAUSED"].');
const MULTI_ADS = {
  type: "string", enum: ["OPT_OUT", "OPT_IN"], default: "OPT_OUT",
  description: "Quảng cáo đa bên (multi-advertiser ads). Mặc định OPT_OUT = tắt; chỉ OPT_IN khi người dùng yêu cầu rõ.",
};
const BUDGET_NOTE =
  "Nhập theo đơn vị tiền tệ của tài khoản: VND = số đồng (200000), USD = số đô (20 = $20). " +
  "Bị chặn nếu vượt giới hạn an toàn BUDGET_CAPS.";

export const TOOLS: Tool[] = [
  // ------------------------------------------------------------ tài khoản
  {
    name: "check_connection",
    description: "Kiểm tra token Meta có hoạt động không và xem cấu hình (giới hạn ngân sách, tài khoản đồng bộ).",
    inputSchema: schema({}),
    annotations: READ,
    async run(_a, env, meta) {
      return {
        me: await meta.request("GET", "me", { fields: "id,name" }),
        api_version: env.META_API_VERSION || "v24.0",
        default_account: env.DEFAULT_AD_ACCOUNT || null,
        default_page: env.DEFAULT_PAGE_ID || null,
        budget_caps: JSON.parse(env.BUDGET_CAPS || "{}"),
        sync_accounts: env.SYNC_ACCOUNTS || "tất cả tài khoản ACTIVE",
      };
    },
  },
  {
    name: "list_ad_accounts",
    description: "Liệt kê tài khoản quảng cáo (id, tên, trạng thái, tiền tệ, múi giờ, đã chi, số dư, giới hạn chi tiêu). Số tiền đã đổi sang đơn vị thường.",
    inputSchema: schema({ limit: int("Số lượng tối đa", 50) }),
    annotations: READ,
    async run(a, _env, meta) {
      const rows = await meta.getAll("me/adaccounts", {
        fields: "id,name,account_status,currency,timezone_name,amount_spent,balance,spend_cap",
      }, a.limit ?? 50);
      return rows.map((r) => {
        const off = currencyOffset(r.currency);
        const m = (v: string | undefined) => (v === undefined ? null : Number(v) / off);
        return {
          ...r, account_status: ACCOUNT_STATUS[r.account_status] ?? r.account_status,
          amount_spent: m(r.amount_spent), balance: m(r.balance), spend_cap: m(r.spend_cap),
        };
      });
    },
  },
  {
    name: "list_pages",
    description: "Liệt kê Fanpage mà token quản lý (cần page_id để tạo creative).",
    inputSchema: schema({ limit: int("Số lượng tối đa", 50) }),
    annotations: READ,
    run: (a, _env, meta) => meta.getAll("me/accounts", { fields: "id,name,category" }, a.limit ?? 50),
  },

  // ------------------------------------------------------------ đọc
  {
    name: "list_campaigns",
    description: "Liệt kê campaign của 1 tài khoản quảng cáo (ngân sách ở đơn vị nhỏ nhất của Meta: USD = cent).",
    inputSchema: schema({ account_id: ACCOUNT, effective_status: STATUS_FILTER, limit: int("Số lượng tối đa", 50) }),
    annotations: READ,
    run: (a, env, meta) => meta.getAll(`${act(a.account_id, env)}/campaigns`, {
      fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,bid_strategy,created_time,start_time,stop_time",
      effective_status: a.effective_status,
    }, a.limit ?? 50),
  },
  {
    name: "list_adsets",
    description: "Liệt kê ad set của 1 campaign (campaign_id) hoặc cả tài khoản (account_id).",
    inputSchema: schema({
      campaign_id: str("ID campaign (tuỳ chọn)"), account_id: ACCOUNT, effective_status: STATUS_FILTER,
      limit: int("Số lượng tối đa", 50),
    }),
    annotations: READ,
    run: (a, env, meta) => meta.getAll(`${a.campaign_id || act(a.account_id, env)}/adsets`, {
      fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal," +
        "billing_event,destination_type,bid_strategy,targeting,start_time,end_time",
      effective_status: a.effective_status,
    }, a.limit ?? 50),
  },
  {
    name: "list_ads",
    description: "Liệt kê quảng cáo. parent_id là campaign_id hoặc adset_id; bỏ trống thì lấy theo account_id.",
    inputSchema: schema({
      parent_id: str("ID campaign hoặc ad set (tuỳ chọn)"), account_id: ACCOUNT, effective_status: STATUS_FILTER,
      limit: int("Số lượng tối đa", 50),
    }),
    annotations: READ,
    run: (a, env, meta) => meta.getAll(`${a.parent_id || act(a.account_id, env)}/ads`, {
      fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id,name}",
      effective_status: a.effective_status,
    }, a.limit ?? 50),
  },
  {
    name: "get_insights",
    description:
      "Báo cáo hiệu quả TRỰC TIẾP từ Meta (số mới nhất). Dùng get_saved_report nếu muốn xem dữ liệu lịch sử đã lưu ở Supabase.",
    inputSchema: schema({
      object_id: str("act_..., campaign, adset hoặc ad id. Bỏ trống = tài khoản mặc định."),
      level: { type: "string", enum: ["account", "campaign", "adset", "ad"], default: "campaign" },
      date_preset: str("today, yesterday, last_3d, last_7d (mặc định), last_14d, last_30d, this_month, last_month, maximum"),
      since: str("YYYY-MM-DD (dùng cùng until, thay cho date_preset)"),
      until: str("YYYY-MM-DD"),
      time_increment: str("'1' = chia theo ngày, 'monthly' = theo tháng"),
      breakdowns: str("vd 'age,gender', 'publisher_platform', 'region', 'country'"),
      fields: str("Danh sách trường, bỏ trống = bộ mặc định"),
      limit: int("Số dòng tối đa", 200),
    }),
    annotations: READ,
    run(a, env, meta) {
      const params: Args = {
        level: a.level || "campaign",
        fields: a.fields || "campaign_id,campaign_name,adset_name,ad_name,spend,impressions,reach,frequency," +
          "clicks,inline_link_clicks,ctr,cpc,cpm,actions,action_values,cost_per_action_type",
        time_increment: a.time_increment,
        breakdowns: a.breakdowns,
      };
      if (a.since && a.until) params.time_range = { since: a.since, until: a.until };
      else params.date_preset = a.date_preset || "last_7d";
      return meta.getAll(`${a.object_id || act(undefined, env)}/insights`, params, a.limit ?? 200);
    },
  },
  {
    name: "get_object",
    description: "Đọc chi tiết 1 đối tượng bất kỳ (campaign, ad set, ad, creative, video, page...) theo id.",
    inputSchema: schema({ object_id: str("ID đối tượng"), fields: str("Danh sách trường, vd 'name,status'") }, ["object_id"]),
    annotations: READ,
    run: (a, _env, meta) => meta.request("GET", a.object_id, a.fields ? { fields: a.fields } : {}),
  },
  {
    name: "search_targeting",
    description:
      "Tìm ID để target. search_type: adinterest (sở thích), adgeolocation (địa điểm, dùng location_types), " +
      "adTargetingCategory (hành vi / nhân khẩu học).",
    inputSchema: schema({
      query: str("Từ khoá, vd 'yoga', 'Hà Nội', 'Magic: The Gathering'"),
      search_type: { type: "string", enum: ["adinterest", "adgeolocation", "adTargetingCategory"], default: "adinterest" },
      location_types: strList('vd ["city"], ["region"], ["country"]'),
      limit: int("Số kết quả", 25),
    }, ["query"]),
    annotations: READ,
    async run(a, _env, meta) {
      const type = a.search_type || "adinterest";
      const params: Args = { type, q: a.query, limit: a.limit ?? 25 };
      if (type === "adgeolocation") params.location_types = a.location_types ?? ["country", "region", "city"];
      return (await meta.request("GET", "search", params)).data ?? [];
    },
  },
  {
    name: "list_page_posts",
    description:
      "Liệt kê bài viết + reel gần đây của 1 Fanpage (tự dùng page token) để lấy post_id cho create_creative_from_post. " +
      "Truyền url (link bài/reel người dùng gửi) để lọc đúng bài: so theo pfbid, số ID trong link, /reel/<id>, story_fbid.",
    inputSchema: schema({
      page_id: str("ID Fanpage (xem list_pages)"),
      url: str("Link bài viết hoặc reel cần tìm (tuỳ chọn)"),
      limit: int("Số bài gần nhất mỗi loại (bài viết, reel) để quét, tối đa 100", 25),
    }, ["page_id"]),
    annotations: READ,
    async run(a, _env, meta) {
      const pageId = a.page_id;
      const token = await meta.pageToken(pageId);
      const limit = Math.min(a.limit ?? 25, 100);
      const cut = (s?: string) => (s && s.length > 160 ? s.slice(0, 160) + "…" : s ?? "");
      const posts = (await meta.request("GET", `${pageId}/posts`, {
        fields: "id,message,permalink_url,created_time,status_type,full_picture", limit,
      }, undefined, false, token)).data ?? [];
      const rows: Args[] = posts.map((p: Args) => ({
        post_id: p.id, loai: p.status_type || "post", noi_dung: cut(p.message), link: p.permalink_url,
        ngay: p.created_time, anh: p.full_picture,
      }));
      let reels: Args[] = [];
      try {
        reels = (await meta.request("GET", `${pageId}/video_reels`, {
          fields: "id,description,permalink_url,created_time,post_id", limit,
        }, undefined, false, token)).data ?? [];
      } catch {
        reels = (await meta.request("GET", `${pageId}/video_reels`, {
          fields: "id,description,permalink_url,created_time", limit,
        }, undefined, false, token).catch(() => ({ data: [] }))).data ?? [];
      }
      for (const r of reels) {
        const postId = r.post_id ? (String(r.post_id).includes("_") ? r.post_id : `${pageId}_${r.post_id}`) : `${pageId}_${r.id}`;
        if (rows.some((x) => x.post_id === postId)) continue;
        rows.push({ post_id: postId, video_id: r.id, loai: "reel", noi_dung: cut(r.description),
          link: r.permalink_url?.startsWith("http") ? r.permalink_url : `https://www.facebook.com${r.permalink_url ?? ""}`,
          ngay: r.created_time });
      }
      rows.sort((x, y) => String(y.ngay).localeCompare(String(x.ngay)));
      if (!a.url) return rows;
      const keys = new Set<string>();
      for (const m of String(a.url).matchAll(/pfbid[0-9A-Za-z]+|\d{8,}/g)) keys.add(m[0]);
      const hits = rows.filter((r) => [...keys].some((k) =>
        String(r.link ?? "").includes(k) || String(r.post_id).endsWith(`_${k}`) || r.video_id === k));
      return hits.length
        ? { tim_thay: hits }
        : { tim_thay: [], ghi_chu: `Không khớp link trong ${rows.length} bài gần nhất. Tăng limit hoặc chọn theo nội dung.`, bai_gan_day: rows };
    },
  },
  {
    name: "preview_ad",
    description: "Lấy bản xem trước (iframe HTML) của ad hoặc creative.",
    inputSchema: schema({
      ad_or_creative_id: str("ID ad hoặc creative"),
      ad_format: str("MOBILE_FEED_STANDARD (mặc định), DESKTOP_FEED_STANDARD, INSTAGRAM_STANDARD, INSTAGRAM_STORY, FACEBOOK_STORY_MOBILE..."),
    }, ["ad_or_creative_id"]),
    annotations: READ,
    async run(a, _env, meta) {
      const body = await meta.request("GET", `${a.ad_or_creative_id}/previews`, { ad_format: a.ad_format || "MOBILE_FEED_STANDARD" });
      return body.data ?? [];
    },
  },

  // ------------------------------------------------------------ tạo mới (luôn PAUSED mặc định)
  {
    name: "create_campaign",
    description:
      "Tạo campaign (mặc định PAUSED). Truyền daily_budget/lifetime_budget để bật ngân sách cấp campaign (CBO) — " +
      "khi đó ad set không được đặt ngân sách. " + BUDGET_NOTE,
    inputSchema: schema({
      account_id: ACCOUNT,
      name: str("Tên campaign"),
      objective: {
        type: "string",
        enum: ["OUTCOME_AWARENESS", "OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_APP_PROMOTION"],
      },
      daily_budget: money("Ngân sách ngày (CBO)"),
      lifetime_budget: money("Ngân sách trọn đời (CBO)"),
      bid_strategy: str("LOWEST_COST_WITHOUT_CAP (mặc định), LOWEST_COST_WITH_BID_CAP, COST_CAP"),
      special_ad_categories: strList('[] hoặc ["HOUSING"], ["EMPLOYMENT"], ["FINANCIAL_PRODUCTS_SERVICES"]...'),
      status: { type: "string", enum: ["PAUSED", "ACTIVE"], default: "PAUSED" },
    }, ["account_id", "name", "objective"]),
    annotations: WRITE,
    async run(a, env, meta) {
      const account = act(a.account_id, env);
      const b = await meta.budget(account, a.daily_budget, a.lifetime_budget);
      const params: Args = {
        name: a.name, objective: a.objective, status: checkStatus(a.status || "PAUSED"), buying_type: "AUCTION",
        special_ad_categories: a.special_ad_categories ?? [],
      };
      if (b.daily || b.lifetime) {
        if (b.daily) params.daily_budget = b.daily;
        else params.lifetime_budget = b.lifetime;
        params.bid_strategy = a.bid_strategy || "LOWEST_COST_WITHOUT_CAP";
      } else {
        params.is_adset_budget_sharing_enabled = false;
      }
      return meta.request("POST", `${account}/campaigns`, params);
    },
  },
  {
    name: "create_adset",
    description:
      "Tạo ad set (mặc định PAUSED). targeting ví dụ: " +
      '{"geo_locations":{"countries":["US"]},"age_min":25,"age_max":55,"genders":[1],' +
      '"flexible_spec":[{"interests":[{"id":"...","name":"..."}]}],"publisher_platforms":["facebook","instagram"]}. ' +
      "Nếu thiếu targeting_automation sẽ tự thêm advantage_audience=0. " +
      "Tin nhắn: destination_type=MESSENGER, optimization_goal=CONVERSATIONS, promoted_object={page_id}. " +
      "Lead form: optimization_goal=LEAD_GENERATION, destination_type=ON_AD, promoted_object={page_id}. " +
      "Mua hàng website: optimization_goal=OFFSITE_CONVERSIONS, promoted_object={pixel_id, custom_event_type:'PURCHASE'}. " +
      BUDGET_NOTE,
    inputSchema: schema({
      account_id: ACCOUNT,
      campaign_id: str("ID campaign"),
      name: str("Tên ad set"),
      optimization_goal: str("LINK_CLICKS, LANDING_PAGE_VIEWS, REACH, IMPRESSIONS, POST_ENGAGEMENT, LEAD_GENERATION, CONVERSATIONS, OFFSITE_CONVERSIONS, THRUPLAY..."),
      targeting: obj("Targeting spec của Meta"),
      daily_budget: money("Ngân sách ngày (chỉ khi campaign không bật CBO)"),
      lifetime_budget: money("Ngân sách trọn đời (cần end_time)"),
      billing_event: str("IMPRESSIONS (mặc định), LINK_CLICKS, THRUPLAY"),
      bid_strategy: str("LOWEST_COST_WITHOUT_CAP (mặc định), LOWEST_COST_WITH_BID_CAP, COST_CAP"),
      bid_amount: money("Giá thầu / cost cap (đơn vị thường)"),
      start_time: str("ISO 8601, vd 2026-10-01T08:00:00+0700"),
      end_time: str("ISO 8601"),
      destination_type: str("WEBSITE, MESSENGER, ON_AD, WHATSAPP, INSTAGRAM_DIRECT..."),
      promoted_object: obj("vd {page_id} hoặc {pixel_id, custom_event_type}"),
      status: { type: "string", enum: ["PAUSED", "ACTIVE"], default: "PAUSED" },
    }, ["account_id", "campaign_id", "name", "optimization_goal", "targeting"]),
    annotations: WRITE,
    async run(a, env, meta) {
      const account = act(a.account_id, env);
      const b = await meta.budget(account, a.daily_budget, a.lifetime_budget);
      const targeting = { targeting_automation: { advantage_audience: 0 }, ...a.targeting };
      const params: Args = {
        campaign_id: a.campaign_id, name: a.name, optimization_goal: a.optimization_goal,
        billing_event: a.billing_event || "IMPRESSIONS", targeting, status: checkStatus(a.status || "PAUSED"),
        start_time: a.start_time, end_time: a.end_time, destination_type: a.destination_type,
        promoted_object: a.promoted_object,
      };
      if (b.daily || b.lifetime) {
        if (b.daily) params.daily_budget = b.daily;
        else params.lifetime_budget = b.lifetime;
        params.bid_strategy = a.bid_strategy || "LOWEST_COST_WITHOUT_CAP";
      } else if (a.bid_strategy) {
        params.bid_strategy = a.bid_strategy;
      }
      if (a.bid_amount) {
        const { currency } = await meta.currencyOf(account);
        params.bid_amount = Math.round(a.bid_amount * currencyOffset(currency));
      }
      return meta.request("POST", `${account}/adsets`, params);
    },
  },
  {
    name: "upload_image",
    description:
      "Upload ảnh từ URL công khai (Google Drive public, Supabase Storage, website...) vào thư viện ảnh tài khoản, trả về image_hash. " +
      "Ảnh nằm trên máy người dùng: không dùng tool này, gửi file tới endpoint POST /upload-image/<MCP_AUTH_KEY>?account_id=act_... " +
      "(body = byte ảnh) — script tai-anh-len.ps1 của skill fb-05-set-quang-cao làm việc này.",
    inputSchema: schema({ account_id: ACCOUNT, image_url: str("URL ảnh http(s)") }, ["account_id", "image_url"]),
    annotations: WRITE,
    async run(a, env, meta) {
      const resp = await fetch(a.image_url);
      if (!resp.ok) throw new ToolError(`Không tải được ảnh (${resp.status}) từ ${a.image_url}`);
      const filename = new URL(a.image_url).pathname.split("/").pop() || "image.jpg";
      const body = await meta.request("POST", `${act(a.account_id, env)}/adimages`, {}, {
        field: "filename", blob: await resp.blob(), filename,
      });
      const img: any = Object.values(body.images ?? {})[0] ?? {};
      return { image_hash: img.hash, url: img.url };
    },
  },
  {
    name: "upload_video",
    description: "Upload video từ URL công khai, trả về video_id. Meta cần vài phút xử lý — kiểm tra get_object(video_id, 'status').",
    inputSchema: schema({ account_id: ACCOUNT, video_url: str("URL video http(s)"), name: str("Tên video") }, ["account_id", "video_url"]),
    annotations: WRITE,
    run: (a, env, meta) => meta.request("POST", `${act(a.account_id, env)}/advideos`, { file_url: a.video_url, name: a.name }),
  },
  {
    name: "create_ad_creative",
    description:
      "Tạo creative dạng ảnh (image_hash) hoặc video (video_id + thumbnail_url/image_hash). " +
      "call_to_action=MESSAGE_PAGE thì không cần link (mở Messenger).",
    inputSchema: schema({
      account_id: ACCOUNT,
      name: str("Tên creative"),
      page_id: str("Fanpage đứng tên quảng cáo"),
      message: str("Nội dung chính (primary text)"),
      link: str("URL đích"),
      headline: str("Tiêu đề"),
      description: str("Mô tả dưới tiêu đề"),
      image_hash: str("Từ upload_image"),
      video_id: str("Từ upload_video"),
      thumbnail_url: str("Ảnh bìa video"),
      call_to_action: str("LEARN_MORE (mặc định), SHOP_NOW, SIGN_UP, CONTACT_US, GET_OFFER, ORDER_NOW, BUY_NOW, MESSAGE_PAGE, WHATSAPP_MESSAGE, SUBSCRIBE..."),
      instagram_user_id: str("ID tài khoản Instagram (nếu chạy cả IG)"),
      multi_advertiser: MULTI_ADS,
    }, ["account_id", "name", "message"]),
    annotations: WRITE,
    async run(a, env, meta) {
      const pageId = a.page_id || env.DEFAULT_PAGE_ID;
      if (!pageId) throw new ToolError("Thiếu page_id. Gọi list_pages để xem danh sách Fanpage.");
      const ctaType = (a.call_to_action || "LEARN_MORE").toUpperCase();
      let link = a.link;
      let cta: Args;
      if (ctaType === "MESSAGE_PAGE") {
        link ||= "https://fb.com/messenger_doc/";
        cta = { type: ctaType, value: { app_destination: "MESSENGER" } };
      } else {
        if (!link) throw new ToolError("Thiếu link (URL đích).");
        cta = { type: ctaType, value: { link } };
      }
      const clean = (o: Args) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));
      const spec: Args = { page_id: pageId, instagram_user_id: a.instagram_user_id };
      if (a.video_id) {
        if (!a.thumbnail_url && !a.image_hash) throw new ToolError("Creative video cần thumbnail_url hoặc image_hash.");
        spec.video_data = clean({
          video_id: a.video_id, message: a.message, title: a.headline, link_description: a.description,
          call_to_action: cta, image_url: a.thumbnail_url, image_hash: a.thumbnail_url ? undefined : a.image_hash,
        });
      } else {
        spec.link_data = clean({
          link, message: a.message, name: a.headline, description: a.description, image_hash: a.image_hash,
          call_to_action: cta,
        });
      }
      return meta.request("POST", `${act(a.account_id, env)}/adcreatives`, {
        name: a.name, object_story_spec: clean(spec),
        contextual_multi_ads: { enroll_status: a.multi_advertiser || "OPT_OUT" },
      });
    },
  },
  {
    name: "create_creative_from_post",
    description:
      "Tạo creative từ bài viết có sẵn trên Fanpage (giữ like/comment/share). post_id dạng '<page_id>_<post_id>' hoặc " +
      "'<post_id>' kèm page_id (lấy bằng list_page_posts). Truyền call_to_action + link để thay nút của bài (vd bài reel " +
      "mặc định 'Gửi tin nhắn' -> SHOP_NOW dẫn tới trang sản phẩm) — nên làm vậy với chiến dịch Sales/Traffic. " +
      "Chiến dịch tin nhắn: call_to_action=MESSAGE_PAGE, không cần link. Meta cần vài phút xử lý nút mới.",
    inputSchema: schema({
      account_id: ACCOUNT, name: str("Tên creative"), post_id: str("ID bài viết"), page_id: str("ID Fanpage"),
      call_to_action: str("Nút thay thế: MESSAGE_PAGE (tin nhắn), SHOP_NOW, LEARN_MORE, ORDER_NOW, BUY_NOW, SIGN_UP..."),
      link: str("URL đích của nút (bắt buộc khi có call_to_action, trừ MESSAGE_PAGE)"),
      multi_advertiser: MULTI_ADS,
    }, ["account_id", "name", "post_id"]),
    annotations: WRITE,
    run(a, env, meta) {
      let postId: string = a.post_id;
      if (!postId.includes("_")) {
        const pageId = a.page_id || env.DEFAULT_PAGE_ID;
        if (!pageId) throw new ToolError("Thiếu page_id để ghép với post_id.");
        postId = `${pageId}_${postId}`;
      }
      const params: Args = {
        name: a.name, object_story_id: postId,
        contextual_multi_ads: { enroll_status: a.multi_advertiser || "OPT_OUT" },
      };
      if (a.call_to_action) {
        const type = a.call_to_action.toUpperCase();
        if (type === "MESSAGE_PAGE") {
          params.call_to_action = { type, value: { app_destination: "MESSENGER" } };
        } else {
          if (!a.link) throw new ToolError("Thiếu link cho nút call_to_action.");
          params.call_to_action = { type, value: { link: a.link } };
        }
      }
      return meta.request("POST", `${act(a.account_id, env)}/adcreatives`, params);
    },
  },
  {
    name: "create_ad",
    description: "Tạo quảng cáo trong ad set từ creative có sẵn (mặc định PAUSED).",
    inputSchema: schema({
      account_id: ACCOUNT, adset_id: str("ID ad set"), creative_id: str("ID creative"), name: str("Tên quảng cáo"),
      status: { type: "string", enum: ["PAUSED", "ACTIVE"], default: "PAUSED" },
    }, ["account_id", "adset_id", "creative_id", "name"]),
    annotations: WRITE,
    run: (a, env, meta) => meta.request("POST", `${act(a.account_id, env)}/ads`, {
      name: a.name, adset_id: a.adset_id, creative: { creative_id: a.creative_id }, status: checkStatus(a.status || "PAUSED"),
    }),
  },

  // ------------------------------------------------------------ điều khiển
  {
    name: "update_status",
    description: "Bật (ACTIVE) / tắt (PAUSED) / lưu trữ (ARCHIVED) campaign, ad set hoặc ad. ACTIVE = bắt đầu tiêu tiền thật: phải hỏi người dùng xác nhận trước.",
    inputSchema: schema({ object_id: str("ID campaign / ad set / ad"), status: { type: "string", enum: ["ACTIVE", "PAUSED", "ARCHIVED"] } },
      ["object_id", "status"]),
    annotations: CONTROL,
    run: (a, _env, meta) => meta.request("POST", a.object_id, { status: checkStatus(a.status) }),
  },
  {
    name: "update_budget",
    description: "Đổi ngân sách campaign (CBO) hoặc ad set. Tăng ngân sách phải hỏi người dùng xác nhận trước. " + BUDGET_NOTE,
    inputSchema: schema({ object_id: str("ID campaign / ad set"), daily_budget: money("Ngân sách ngày"), lifetime_budget: money("Ngân sách trọn đời") },
      ["object_id"]),
    annotations: CONTROL,
    async run(a, _env, meta) {
      const b = await meta.budget(a.object_id, a.daily_budget, a.lifetime_budget);
      if (!b.daily && !b.lifetime) throw new ToolError("Cần truyền daily_budget hoặc lifetime_budget.");
      return meta.request("POST", a.object_id, b.daily ? { daily_budget: b.daily } : { lifetime_budget: b.lifetime });
    },
  },
  {
    name: "update_object",
    description:
      'Sửa trường bất kỳ của campaign / ad set / ad, vd {"name":"..."}, {"targeting":{...}}, {"end_time":"..."}. ' +
      "Đổi ngân sách hãy dùng update_budget.",
    inputSchema: schema({ object_id: str("ID đối tượng"), fields: obj("Các trường cần sửa") }, ["object_id", "fields"]),
    annotations: CONTROL,
    run(a, _env, meta) {
      const fields: Args = { ...a.fields };
      if ("daily_budget" in fields || "lifetime_budget" in fields || "bid_amount" in fields) {
        throw new ToolError("Dùng update_budget để đổi ngân sách (có kiểm tra giới hạn an toàn).");
      }
      if (fields.status) fields.status = checkStatus(fields.status);
      return meta.request("POST", a.object_id, fields);
    },
  },

  // ------------------------------------------------------------ Supabase
  {
    name: "sync_to_supabase",
    description:
      "Kéo campaign / ad set / ad và số liệu theo ngày (cấp ad) từ Meta về Supabase. Tự chạy mỗi 6 tiếng cho 3 ngày gần nhất; " +
      "gọi tay để đồng bộ ngay hoặc nạp lịch sử (tối đa 93 ngày mỗi lần).",
    inputSchema: schema({
      account_ids: strList("Danh sách act_... ; bỏ trống = mọi tài khoản ACTIVE"),
      days: int("Số ngày gần nhất", 3),
      since: str("YYYY-MM-DD (tuỳ chọn, dùng cùng until)"),
      until: str("YYYY-MM-DD"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: (a, env) => syncAll(env, { days: a.days, since: a.since, until: a.until }, "manual", a.account_ids),
  },
  {
    name: "get_saved_report",
    description:
      "Báo cáo từ dữ liệu đã lưu ở Supabase (nhanh, xem được lịch sử dài). Có chi tiêu, CTR, CPC, CPM, tin nhắn, lead, " +
      "thêm giỏ, mua hàng, doanh thu, ROAS và chi phí/kết quả. level='day' để xem xu hướng theo ngày.",
    inputSchema: schema({
      since: str("YYYY-MM-DD"),
      until: str("YYYY-MM-DD"),
      level: { type: "string", enum: ["account", "campaign", "adset", "ad", "day"], default: "campaign" },
      account_id: ACCOUNT,
    }, ["since", "until"]),
    annotations: READ,
    run: (a, env) => rpc(env, "meta_report", {
      p_since: a.since, p_until: a.until, p_level: a.level || "campaign",
      p_account: a.account_id ? act(a.account_id, env) : null,
    }),
  },
];

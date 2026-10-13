import { handleDashboard } from "./dashboard";
import { handleMcp } from "./mcp";
import { Env, Meta, ToolError, act } from "./meta";
import { supabaseReady } from "./supabase";
import { syncAccount, syncAll } from "./sync";

/** Khoá truy cập nhận qua header "Authorization: Bearer <key>" hoặc đường dẫn /mcp/<key>. */
function authorized(req: Request, url: URL, env: Env): boolean {
  if (!env.MCP_AUTH_KEY) return false;
  const fromHeader = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const fromPath = url.pathname.split("/")[2] ?? "";
  const enc = new TextEncoder();
  const expected = enc.encode(env.MCP_AUTH_KEY);
  return [fromHeader, fromPath].some((given) => {
    const got = enc.encode(given);
    return got.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(got, expected);
  });
}

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/") return new Response("meta-ads-mcp đang chạy.");

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      if (!authorized(req, url, env)) return new Response("Unauthorized", { status: 401 });
      return handleMcp(req, env);
    }

    if (url.pathname.startsWith("/dash/")) {
      if (!authorized(req, url, env)) return new Response("Unauthorized", { status: 401 });
      return handleDashboard(url, env);
    }

    // Tải ảnh từ máy người dùng vào thư viện ảnh quảng cáo: POST /upload-image/<key>?account_id=act_...&filename=...
    // body = byte ảnh. Trả {image_hash, url}. (Tool MCP không mang được file vài MB nên cần đường riêng.)
    if (url.pathname.startsWith("/upload-image/") && req.method === "POST") {
      if (!authorized(req, url, env)) return new Response("Unauthorized", { status: 401 });
      try {
        const account = act(url.searchParams.get("account_id") ?? undefined, env);
        const blob = await req.blob();
        if (!blob.size) throw new ToolError("Body rỗng — cần gửi byte ảnh.");
        if (blob.size > 30 * 1024 * 1024) throw new ToolError("Ảnh quá 30MB.");
        const filename = url.searchParams.get("filename") || "anh-quang-cao.png";
        const body = await new Meta(env).request("POST", `${account}/adimages`, {}, { field: "filename", blob, filename });
        const img: any = Object.values(body.images ?? {})[0] ?? {};
        return Response.json({ image_hash: img.hash, url: img.url, account });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `Lỗi không mong đợi: ${e instanceof Error ? e.message : e}`;
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    // Tải ảnh từ máy người dùng lên Fanpage dưới dạng ảnh CHƯA ĐĂNG (để ghép bài nhiều ảnh bằng tool publish_page_post):
    // POST /upload-page-photo/<key>?page_id=...&filename=...  body = byte ảnh. Trả {photo_id}.
    if (url.pathname.startsWith("/upload-page-photo/") && req.method === "POST") {
      if (!authorized(req, url, env)) return new Response("Unauthorized", { status: 401 });
      try {
        const pageId = (url.searchParams.get("page_id") || env.DEFAULT_PAGE_ID || "").trim();
        if (!pageId) throw new ToolError("Thiếu page_id.");
        const blob = await req.blob();
        if (!blob.size) throw new ToolError("Body rỗng — cần gửi byte ảnh.");
        if (blob.size > 30 * 1024 * 1024) throw new ToolError("Ảnh quá 30MB.");
        const filename = url.searchParams.get("filename") || "anh-bai-viet.jpg";
        const meta = new Meta(env);
        const token = await meta.pageToken(pageId);
        // Ảnh cho bài hẹn giờ phải tải với temporary=true (Meta yêu cầu): thêm &temporary=1
        const temporary = url.searchParams.get("temporary") === "1" ? true : undefined;
        const body = await meta.request("POST", `${pageId}/photos`, { published: false, temporary },
          { field: "source", blob, filename }, false, token);
        return Response.json({ photo_id: body.id, page_id: pageId });
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `Lỗi không mong đợi: ${e instanceof Error ? e.message : e}`;
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    // Được syncAll gọi qua service binding: mỗi tài khoản 1 lần chạy riêng.
    if (url.pathname === "/internal/sync" && req.method === "POST") {
      if (!authorized(req, url, env)) return new Response("Unauthorized", { status: 401 });
      const { account, trigger, days, since, until, offset, structure } = await req.json<any>();
      return Response.json(await syncAccount(env, account, { days, since, until, offset, structure }, trigger || "manual"));
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    if (!supabaseReady(env)) return; // chưa cài Supabase: không có gì để đồng bộ
    ctx.waitUntil(syncAll(env, {}, "cron").then((r) => console.log("cron sync", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;

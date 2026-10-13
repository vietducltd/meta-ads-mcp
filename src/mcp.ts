/**
 * MCP server tối giản theo chuẩn Streamable HTTP, chế độ stateless (mỗi POST là 1 JSON-RPC độc lập,
 * trả JSON). Đủ cho Claude Code, Claude Desktop và connector trên claude.ai.
 */
import { Env, Meta, ToolError } from "./meta";
import { TOOLS } from "./tools";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Quản lý quảng cáo Facebook/Instagram qua Meta Marketing API, dữ liệu lịch sử lưu ở Supabase. " +
  "Mọi thứ tạo mới đều ở trạng thái PAUSED. Luôn hỏi người dùng xác nhận trước khi bật ACTIVE hoặc tăng ngân sách. " +
  "Quy trình tạo quảng cáo: create_campaign -> create_adset -> upload_image/upload_video -> create_ad_creative -> " +
  "create_ad -> preview_ad -> (người dùng đồng ý) update_status ACTIVE. " +
  "Chạy bài có sẵn trên page: list_page_posts (truyền url bài) -> create_creative_from_post thay cho upload + create_ad_creative. " +
  "Đăng bài mới lên page rồi chạy quảng cáo (giữ bố cục album, gộp tương tác): tải ảnh qua POST /upload-page-photo/<key> " +
  "(script tai-anh-page.ps1) -> publish_page_post (người dùng phải đồng ý đăng) -> create_creative_from_post " +
  "(MESSAGE_PAGE cho quảng cáo tin nhắn; welcome_from_creative để chép mẫu tin nhắn chào). " +
  "Báo cáo: get_saved_report cho dữ liệu đã lưu (nhanh, lịch sử dài), get_insights cho số trực tiếp từ Meta.";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const result = (id: Rpc["id"], res: unknown) => ({ jsonrpc: "2.0", id, result: res });
const failure = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(msg: Rpc, env: Env) {
  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return result(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "meta-ads", title: "Meta Ads", version: "1.1.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return failure(msg.id, -32602, `Không có tool: ${msg.params?.name}`);
      try {
        const out = await tool.run(msg.params?.arguments ?? {}, env, new Meta(env));
        return result(msg.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        const text = e instanceof ToolError ? e.message : `Lỗi không mong đợi: ${e instanceof Error ? e.message : e}`;
        if (!(e instanceof ToolError)) console.error(tool.name, e);
        return result(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return failure(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }
  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return Response.json(failure(null, -32700, "Parse error"), { status: 400 });
  }
  const messages = Array.isArray(body) ? body : [body];
  const replies = [];
  for (const msg of messages) {
    if (msg.id === undefined || msg.id === null) continue; // notification: không trả lời
    replies.push(await dispatch(msg, env));
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

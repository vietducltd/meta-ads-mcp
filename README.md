# MCP meta-ads — cho Claude tự set quảng cáo Facebook

Bộ mã này dựng một **MCP server** chạy trên Cloudflare Workers (gói miễn phí là
đủ). Nó cho Claude Code gọi Meta Marketing API thay bạn: đọc tài khoản quảng
cáo, tìm bài trên Fanpage, tạo chiến dịch → nhóm quảng cáo → quảng cáo, xem
báo cáo. Dùng cùng skill **fb-05-set-quang-cao**.

**Có sẵn chốt an toàn:**
- Mọi thứ tạo mới đều ở trạng thái **TẠM DỪNG**. Chỉ bật chạy khi bạn đồng ý.
- **Giới hạn ngân sách** (`BUDGET_CAPS`): mặc định tối đa 1.000.000đ/ngày
  hoặc $100/ngày. Vượt mức này MCP từ chối.
- Token Meta nằm trên Cloudflare dưới dạng bí mật. Claude không đọc được, file
  mã cũng không chứa.

Làm lần lượt từ mục 1 đến mục 6, mất khoảng 30–45 phút. Mục 7 (Supabase) là
**tuỳ chọn**.

---

## 1. Cài phần mềm (một lần)

Mở **PowerShell** rồi chạy từng dòng. Lệnh nào báo "đã cài" thì bỏ qua:

```
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Cài xong thì **đóng PowerShell và mở lại**, rồi kiểm tra:

```
node -v
git --version
```

Kết quả đúng: `node -v` ra `v20` trở lên, `git --version` in ra số phiên bản.

Bạn cũng cần **Claude Code**: bản desktop (tab Code trong ứng dụng Claude) hoặc
bản dòng lệnh.

## 2. Lấy token Meta

Cần có: một **Business Manager** (Meta Business Suite) đang quản lý Fanpage và
tài khoản quảng cáo của bạn, và bạn là **quản trị viên** của Business Manager
đó.

> Giao diện Meta hay đổi tên nút. Nếu không thấy đúng chữ như dưới đây, tìm nút
> có ý nghĩa tương tự.

### 2a. Tạo ứng dụng (app) Meta

1. Vào https://developers.facebook.com → **Ứng dụng của tôi** → **Tạo ứng dụng**.
2. Trường hợp sử dụng: chọn **Khác**. Loại ứng dụng: chọn **Doanh nghiệp**
   (Business).
3. Đặt tên app (ví dụ `MCP quang cao`), điền email, chọn **đúng Business
   Manager** của bạn → **Tạo ứng dụng**.
4. Trong trang app: thêm sản phẩm **Marketing API** (bấm **Thiết lập**).
5. Vào **Cài đặt ứng dụng → Thông tin cơ bản**, bấm **Hiển thị** ở ô **Khoá bí
   mật của ứng dụng** (App Secret). Giữ lại giá trị này để dán vào `.env` ở mục 4.

### 2b. Tạo người dùng hệ thống và token (không hết hạn)

1. Vào https://business.facebook.com/settings → **Người dùng → Người dùng hệ
   thống** → **Thêm**. Đặt tên (ví dụ `claude-mcp`), vai trò **Quản trị viên**.
2. Chọn người dùng vừa tạo → **Chỉ định tài sản**:
   - **Trang:** chọn các Fanpage sẽ chạy quảng cáo, bật toàn quyền (hoặc ít nhất
     quyền tạo quảng cáo và xem nội dung).
   - **Tài khoản quảng cáo:** chọn các tài khoản sẽ dùng, quyền **Quản lý**.
   - **Ứng dụng:** chọn app vừa tạo ở 2a. Nếu app chưa hiện, vào **Tài khoản →
     Ứng dụng** của Business Manager để thêm app trước.
3. Bấm **Tạo mã mới** (Generate token) → chọn app ở 2a → thời hạn **Không bao
   giờ** → tick các quyền:

   | Quyền | Để làm gì |
   |---|---|
   | `ads_management`, `ads_read` | Tạo, sửa, đọc quảng cáo |
   | `business_management` | Dùng tài sản trong Business Manager |
   | `pages_show_list` | Thấy danh sách Fanpage |
   | `pages_read_engagement` | Đọc bài viết trên Page (chạy bài có sẵn) |
   | `pages_manage_ads` | Chạy quảng cáo bằng bài của Page |

4. Bấm **Tạo mã** → **sao chép token ngay**, vì Meta chỉ hiện một lần. Token bắt
   đầu bằng `EAA...`

⚠️ Token giống như chìa khoá tài khoản quảng cáo: **không gửi cho ai, không dán
vào khung chat với Claude.** Lỡ lộ thì vào lại người dùng hệ thống, thu hồi và
tạo token mới.

## 3. Tạo tài khoản Cloudflare

Đăng ký miễn phí tại https://dash.cloudflare.com/sign-up, rồi xác nhận email.
Không cần thẻ.

## 4. Tải mã và điền `.env`

Trong PowerShell, chọn nơi để mã (ví dụ ổ D):

```
cd D:\
git clone https://github.com/vietducltd/meta-ads-mcp.git
cd meta-ads-mcp
copy .env.example .env
notepad .env
```

Trong Notepad, điền hai dòng rồi lưu (**Ctrl+S**):

```
META_ACCESS_TOKEN=EAA...token ở mục 2b...
META_APP_SECRET=...khoá bí mật ở mục 2a...
```

Để trống `MCP_AUTH_KEY` và `WORKER_URL`, các lệnh ở mục 5 sẽ tự điền.

## 5. Đưa MCP lên Cloudflare

Vẫn trong thư mục `meta-ads-mcp`, chạy lần lượt:

```
npm install
npx wrangler login
npm run deploy
npm run secrets
```

| Lệnh | Việc nó làm | Nếu được hỏi |
|---|---|---|
| `npm install` | Tải thư viện | — |
| `npx wrangler login` | Mở trình duyệt để đăng nhập Cloudflare | Bấm **Allow** |
| `npm run deploy` | Đưa MCP lên Cloudflare, tự lưu địa chỉ vào `.env` | Lần đầu Cloudflare có thể hỏi đặt tên miền con `workers.dev`: đặt tên bất kỳ, không dấu |
| `npm run secrets` | Đẩy token và khoá lên Cloudflare, tự tạo khoá truy cập MCP | Chỉ in tên các mục, không in giá trị |

## 6. Gắn MCP vào Claude Code

**Dùng Claude Code bản dòng lệnh** (gõ được lệnh `claude`):

```
npm run gan-mcp
```

**Dùng Claude Code bản desktop:** truyền thư mục dự án mà bạn mở trong Claude
Code:

```
npm run gan-mcp -- "D:\du-an-quang-cao"
```

Sau đó **mở lại phiên Claude Code**. Nếu được hỏi có cho phép server
`meta-ads` không, chọn **Cho phép**.

**Kiểm tra:** trong Claude Code, gõ `kiểm tra kết nối MCP quảng cáo`. Skill
fb-05 sẽ chạy bộ kiểm tra 9 mục (M1–M9). Kết quả phải là **SẴN SÀNG**.

## 7. (Tuỳ chọn) Supabase: báo cáo lịch sử và dashboard

Không có Supabase vẫn set quảng cáo và xem số trực tiếp từ Meta bình thường.
Cài thêm Supabase thì MCP tự lưu số liệu **mỗi 6 tiếng**, xem được báo cáo dài
ngày và dashboard trên điện thoại.

1. Đăng ký https://supabase.com → **New project** (gói Free). Đặt mật khẩu
   database, chọn khu vực Singapore.
2. Mở **SQL Editor** → **New query**, dán toàn bộ nội dung file
   `supabase/schema.sql` → **Run**.
3. Vào **Project Settings → API**, lấy **Project URL** và khoá **service_role**
   (không lấy khoá anon).
4. Thêm vào `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_KEY=eyJ...service_role...
   ```
5. Chạy `npm run secrets`, rồi nhờ Claude "đồng bộ số liệu quảng cáo 30 ngày".
6. Dashboard: `WORKER_URL/dash/MCP_AUTH_KEY`, lấy hai giá trị này trong `.env`.
   Đừng chia sẻ link này.

## Cập nhật khi có bản mới

```
cd D:\meta-ads-mcp
git pull
npm install
npm run deploy
```

## Lỗi thường gặp

| Hiện tượng | Cách sửa |
|---|---|
| `winget` không có | Tải Node.js LTS ở https://nodejs.org và Git ở https://git-scm.com, cài như phần mềm thường |
| `npm` / `node` không nhận lệnh sau khi cài | Đóng PowerShell, mở lại |
| PowerShell báo "running scripts is disabled" khi chạy `npm` | Chạy một lần: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, chọn **Y** |
| `npm run secrets` báo token không bắt đầu bằng EAA | Dán lại token vào `.env`, không có dấu cách hay ngoặc kép thừa |
| Deploy báo lỗi đăng nhập | Chạy lại `npx wrangler login` |
| Kiểm tra báo M6 (lỗi 190) | Token hết hạn hoặc bị thu hồi: tạo token mới (mục 2b), sửa `.env`, `npm run secrets` |
| Kiểm tra báo M7 / M8 | Người dùng hệ thống chưa được gán tài khoản quảng cáo / Page (mục 2b bước 2), hoặc thiếu quyền khi tạo token |
| Claude không thấy công cụ `mcp__meta-ads__*` | Mở lại phiên Claude Code; kiểm tra đã chạy `npm run gan-mcp` đúng thư mục dự án |
| Đổi tên Worker trong `wrangler.jsonc` | Đổi luôn `"service"` ở mục `services` cho giống tên mới |

## Bảo mật

- **Không gửi** file `.env` và `.mcp.json` cho người khác: chúng chứa token và
  khoá. Cả hai đã nằm trong `.gitignore`.
- Nghi lộ khoá MCP: xoá dòng `MCP_AUTH_KEY` trong `.env`, chạy
  `npm run secrets` (tạo khoá mới), rồi `npm run gan-mcp` lại.

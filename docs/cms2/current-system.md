# Phase 0：現況盤點

> 盤點基準：`Dalimis/full-home` main 分支（2026-10-15，commit `7f4f12e`）。
> 標「推斷」的項目是從程式碼反推，尚未對照正式 D1 的實際 schema。

## 1. 系統架構

```
瀏覽器
  │
Cloudflare（DNS / CDN / WAF / Redirect Rule：full-home.com.tw → www 301）
  │
  ├─ www.full-home.com.tw/*                       → Pages「full-home」        repo: site/
  ├─ /admin*、/api/admin*                          → Cloudflare Access（OTP，5 個 email）
  │                                                  → Worker「fullhome-cms」  repo: workers/cms/
  ├─ /api/public/investors*、/files/*              → Worker「fullhome-cms」（公開）
  └─ /api/contact*（www + 根網域）                 → Worker「fullhome-contact」repo: workers/contact/
                                                     → Microsoft Graph sendMail

fullhome-cms 繫結：D1 fullhome-cms-db（DB）、R2 fullhome-files（FILES）
三個服務皆由 Git main 分支自動部署（Workers Builds / Pages Git integration）
WAF 限速：/api/contact 同 IP 10 秒 2 次
```

## 2. 前台檔案

| 檔案 | 行數 | 說明 |
|---|---|---|
| `site/index.html` | 2,651 | 單頁首頁：hero、about、services、why、team、investors、process、faq、contact。CSS/JS 全部內嵌，logo 為 base64，背景圖用 Unsplash 外部連結 |
| `site/investors/*.html` | 37–72 | 投資人專區 8 頁（公司資料、治理、股東會、財務、永續、股價、聯絡人、首頁） |
| `site/assets/investors-cms.js` | 196 | 讀 `/api/public/investors`，依 `data-cms-*` 屬性把資料填入頁面；失敗時保留 HTML 內建內容 |
| `site/assets/investors.css` | 59 | 投資人頁樣式 |

**沒有**：獨立的企業介紹頁、服務頁、最新消息、建案頁。這些內容目前都寫死在 `index.html` 的區塊裡。

## 3. API 清單

### fullhome-cms

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| GET | `/admin/` | Access + JWT | 後台頁面（`adminHtml()` 回傳整頁 HTML/CSS/JS） |
| GET | `/api/public/investors` | 公開 | 公司資料、公開董事、公開文件、公開 FAQ |
| GET | `/files/:id` | 公開 | 從 R2 串流文件（僅 `is_public = 1`） |
| GET | `/api/admin/bootstrap` | 已開通帳號 | 後台所需全部資料 + 目前使用者 + 權限 |
| PUT | `/api/admin/company` | company | 整筆覆寫公司資料（upsert id=1） |
| POST/PUT/DELETE | `/api/admin/board[/:id]` | board | 董事 CRUD |
| POST/PUT/DELETE | `/api/admin/documents[/:id]` | documents | 文件上傳（multipart）/ 修改中繼資料 / 刪除（含 R2） |
| POST/PUT/DELETE | `/api/admin/faqs[/:id]` | faqs | 常見問題 CRUD |
| POST/PUT/DELETE | `/api/admin/users[/:id]` | users | 後台帳號與權限 |

保護層次（admin）：Cloudflare Access → Worker 驗 `Cf-Access-Jwt-Assertion`（RS256/aud/iss/exp）→ 寫入需 `Origin` = 正式網域 → `admin_users` 區塊權限。

### fullhome-contact

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/contact` | 驗證欄位、honeypot → Entra client credentials 取 token → Graph `sendMail`（BCC `MAIL_TO`） |

## 4. 資料表（D1：fullhome-cms-db）

| 資料表 | 來源 | 欄位 |
|---|---|---|
| `company_profile` | 既有（推斷） | id(=1)、company_name、company_name_en、stock_code、phone、address、chairman、general_manager、spokesperson(+_title/_phone/_email)、deputy_spokesperson(+_title/_phone/_email)、transfer_agent(+_phone/_address)、updated_at |
| `board_members` | 既有（推斷） | id、member_type（董事/獨立董事）、name、title、representative、note、sort_order、is_public、created_at、updated_at |
| `documents` | 既有（推斷） | id、category、subcategory、year、quarter、title、description、file_name、file_key、file_size、mime_type、sort_order、is_public、published_at、created_at、updated_at |
| `faqs` | 程式自動建立 | id、question、answer、sort_order、is_public、created_at、updated_at |
| `admin_users` | 程式自動建立 | id、email(UNIQUE)、name、permissions（逗號字串）、is_active、created_at、updated_at、updated_by |

- **沒有外鍵**，資料表之間沒有關聯。
- 目前資料量（2026-10-15）：董事 8 筆、文件 1 筆（115 年股東會議事手冊，約 6 MB）。
- R2 key 格式：`{分類 slug}/{西元年或 other}/{timestamp}-{uuid}.{ext}`。

## 5. 程式碼檢查結果

### 5.1 架構與維護性

| 項目 | 現況 | 影響 |
|---|---|---|
| 檔案結構 | 單一 `index.js` 4,591 行，其中 `adminHtml()` 約 2,800 行是寫在 JS 樣板字串裡的 HTML/CSS/JS | 前端程式不能用反斜線、反引號、`${`，修改容易出錯；無法單獨測試 |
| CRUD 重複 | company/board/documents/faqs/users 各自手寫 SQL、驗證、前端表格 | 每加一個模組約 300–500 行，約半天到一天 |
| Schema 管理 | 前三張表沒有 migration 檔；後兩張在程式內 `CREATE TABLE IF NOT EXISTS` | 無法重建環境、無法版本化 |
| 路由 | 一連串 `if` 比對 | 可讀但無法擴充；沒有分頁、搜尋、篩選 |

### 5.2 功能缺口與錯誤

| # | 問題 | 嚴重度 |
|---|---|---|
| F1 | **`uploadDocument()` 先寫 R2 再寫 D1**：D1 失敗時 R2 留下孤兒檔案，且沒有任何清理機制 | 中 |
| F2 | **`deleteDocument()` 先刪 R2 再刪 D1**：D1 刪除失敗時，紀錄還在但檔案已不存在，前台出現壞連結 | 中 |
| F3 | `saveCompany()` 整筆覆寫：前端少送欄位會被清成空字串 | 低 |
| F4 | 文件編輯用 `prompt()`，只能改標題/年度/季度/公開；無法改分類、說明、**無法換檔案** | 中（使用體驗） |
| F5 | 年度格式混用：既有資料 `115`（民國），表單提示 `2026`；R2 key 只認 4 碼西元年；`ORDER BY year` 以字串排序 | 低 |
| F6 | `published_at` 一律為上傳時間，沒有排程發布 | 低 |
| F7 | `/files/:id` 回應 `Cache-Control: public, max-age=3600`：文件設為隱藏後，瀏覽器最多仍可快取 1 小時 | 低 |
| F8 | 聯絡表單**沒有保存提交紀錄**，只寄信。寄信失敗或信件被誤刪，客戶資料就不見 | 中 |

### 5.3 安全

| # | 項目 | 現況 |
|---|---|---|
| S1 | 管理 API 保護 | ✅ Access + Worker JWT + Origin + 區塊權限（2026-10-15 補上；**之前 `/api/admin/*` 完全公開**，log 只保留 3 天，更早的存取無法追查） |
| S2 | 公開/隱藏隔離 | ✅ 公開 API 與 `/files` 都有 `is_public = 1` 條件 |
| S3 | 上傳檢查 | 副檔名白名單 + 25 MB 上限；Content-Type 由副檔名決定。❌ 未檢查檔案內容（magic bytes）、❌ 無惡意檔案掃描 |
| S4 | 稽核紀錄 | ⚠️ 只有 Worker log（`admin write ... email`），免費方案約保留 3 天 |
| S5 | 備份 | ⚠️ 只有 D1 Time Travel（Workers Free 7 天、Paid 30 天，還原為原地覆寫）；R2 無備份 |
| S6 | 速率限制 | ✅ `/api/contact`；admin 由 Access 保護 |
| S7 | 登入 | Access One-time PIN；允許名單含 2 個共用信箱（`mis@`），無法對應到個人 |
| S8 | Graph 寄信權限 | App 若為 `Mail.Send` 應用程式權限且未限制範圍，可用全 tenant 任一信箱寄信；Client Secret 有到期日 |

## 6. 技術限制

- Workers 不能執行完整的 Node.js 伺服器（Directus、NocoBase 無法跑在 Workers 上）。
- D1 是 SQLite，適合目前的資料量；不支援 PostgreSQL 專屬功能。
- 帳號目前是 **Workers Free**（Observability 顯示每日 200K events 上限），Worker 大小與 CPU 時間受免費方案限制。
- 前台是手寫靜態 HTML，沒有建置流程、元件或模板；要讓「頁面內容」可在後台編輯，前台必須先改成「資料驅動」。

## 7. 尚缺資料（Phase 1 開始前需要補齊）

| # | 需要什麼 | 怎麼取得 |
|---|---|---|
| M1 | D1 實際 schema | `npx wrangler d1 execute fullhome-cms-db --remote --command "SELECT sql FROM sqlite_master"` |
| M2 | R2 物件數量與容量 | Dashboard → R2 → fullhome-files → 指標 |
| M3 | 舊系統 `/downloads/*` 的檔案清單與來源 | 目前首頁仍連到舊系統的 2024 永續報告書 |
| M4 | 誰會在新 CMS 建立「新資料集合」 | 決定 code-first 或 no-code 方案的關鍵 |
| M5 | CMS 是否只服務馥鴻，還是也要服務達麗、寶信等其他網站 | 影響授權成本攤提 |
| M6 | 預算上限（年費 / 一次性） | 影響方案選擇 |
| M7 | 個資保存期限與存取規範 | 表單提交紀錄的設計依據 |
| M8 | 是否接受升級 Workers Paid（USD 5/月） | Payload on Workers 方案的前提 |

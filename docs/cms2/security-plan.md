# 安全計畫

## 1. 不論選哪個方案，現在就值得修的項目

這些都在現有 `fullhome-cms` / `fullhome-contact` 上修，不影響之後遷移。

| 優先 | 項目 | 做法 | 對應問題 |
|---|---|---|---|
| P0 | 上傳失敗留下孤兒檔案 | `uploadDocument()`：D1 寫入失敗時 `catch` 內刪除剛寫入的 R2 物件；另外每週掃描一次 R2 與 `documents.file_key` 的差異 | F1 |
| P0 | 刪除順序 | `deleteDocument()` 改為：先在 D1 標記刪除（或刪除紀錄）→ 成功後才刪 R2；R2 刪除失敗只記錄、不回滾 | F2 |
| P0 | 表單提交沒有留存 | `fullhome-contact` 寄信前先寫入 D1 `contact_submissions`；寄信失敗也保留紀錄 | F8 |
| P1 | 檔案內容驗證 | 讀取檔頭 magic bytes：PDF 必須以 `%PDF-` 開頭；docx/xlsx/pptx 必須是 ZIP（`PK\x03\x04`）；圖片檢查 JPEG/PNG/WebP 標頭；不符就拒收 | S3 |
| P1 | 稽核紀錄 | 新增 `audit_logs`（誰、何時、哪個集合、哪一筆、修改前後），寫入操作一律記錄；後台提供查詢 | S4 |
| P1 | 定期備份 | Workers Cron 每週把 D1 匯出存到另一個 R2 bucket；R2 每月用 rclone 同步到公司 NAS | S5 |
| P2 | 公司資料部分更新 | `saveCompany()` 只更新有送來的欄位 | F3 |
| P2 | 隱藏文件的快取 | `/files/*` 改為 `Cache-Control: private, max-age=300` | F7 |
| P2 | Access 登入方式 | 識別提供者改用 Entra ID（沿用公司 MFA、離職自動失效）；允許名單移除共用信箱 | S7 |
| P2 | Graph 寄信範圍 | Exchange Application Access Policy / RBAC for Applications，限制只能以 `mis@full-home.com.tw` 寄信；Secret 到期日加入提醒 | S8 |

## 2. 新 CMS 的安全要求

| 面向 | 要求 |
|---|---|
| 驗證 | Cloudflare Access 保護 CMS 後台網域；CMS 本身另有帳號與角色。Access 通過 ≠ CMS 權限 |
| 授權 | 角色 × 集合 × 操作；投資人揭露資料只有網站管理員以上可發布；欄位層級隱藏個資（表單紀錄的電話、地址） |
| 公開 API | 獨立 Worker，只查詢已發布資料；不轉發任何 admin token；只允許 GET |
| Token | 不放在前台 JS；CMS 的 API key 只存在 Worker secret |
| CORS | 公開 API 只允許 `https://www.full-home.com.tw`；CMS 後台與官網不同網域時，管理 API 不開放 CORS |
| CSRF | CMS 的 session cookie 設 `SameSite=Lax` 或 `Strict`；寫入請求檢查 Origin |
| 快取 | 公開 API 用短快取並在發布時清除；管理 API、後台頁面一律 `no-store` |
| 上傳 | 副檔名白名單 + magic bytes + 大小上限；伺服器決定 Content-Type；`nosniff`；檔名不直接當 R2 key |
| 惡意檔案 | Workers 上沒有現成防毒引擎。若有需求：上傳後送到公司既有的防毒或沙箱掃描（例如 NAS 或 Windows Defender 掃描資料夾），掃描通過才設為公開 |
| 速率限制 | 表單已有；CMS 登入頁面加 WAF 限速 |
| 個資 | 表單紀錄設定保存期限（例如 1 年），以排程自動刪除；匯出 CSV 只限有權限的角色，並寫入稽核紀錄 |
| 備份 | 資料庫每日匯出、保留 30 天；R2 每月異地同步；每季實際還原演練一次 |

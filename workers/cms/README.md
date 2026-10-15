# fullhome-cms

馥鴻建設投資人專區 CMS（Cloudflare Worker）。

| 路徑 | 說明 | 保護 |
|---|---|---|
| `/admin/` | 管理後台頁面 | Cloudflare Access + Worker 驗 JWT |
| `/api/admin/*` | 後台 API（讀寫 D1 / R2） | Cloudflare Access + Worker 驗 JWT + Origin 檢查 |
| `/api/public/investors` | 前台讀取公司資料、董事、文件清單 | 公開 |
| `/files/:id` | 公開文件下載（R2） | 公開（僅 `is_public = 1`） |

## 部署

- 由 Cloudflare Workers Builds 監看 `main` 分支、根目錄 `workers/cms`，push 後自動 `npx wrangler deploy`。
- `wrangler.jsonc` 是唯一設定來源：路由、D1/R2 繫結、`ACCESS_*` 變數都寫在這裡。
  **不要在 Dashboard 上改路由或變數**，下次部署會被覆蓋。
- `workers_dev` / `preview_urls` 必須維持 `false`，否則可繞過 Access。

## 回滾

Dashboard → fullhome-cms → 部署 → 選上一版 → 回滾；之後在 repo `git revert` 對應 commit。

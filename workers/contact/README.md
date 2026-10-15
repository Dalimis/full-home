# fullhome-contact

官網「免費初步評估」表單 → Microsoft Graph `sendMail`（以 `MAIL_FROM` 身分寄出，收件人全部 BCC）。

| 項目 | 說明 |
|---|---|
| 路由 | `www.full-home.com.tw/api/contact*`、`full-home.com.tw/api/contact*` |
| 一般變數 | `TENANT_ID`、`CLIENT_ID`、`MAIL_FROM`、`MAIL_TO`（寫在 `wrangler.jsonc`） |
| Secret | `CLIENT_SECRET`（只在 Cloudflare，**不進 repo**；部署不會覆蓋） |
| 防濫用 | honeypot 欄位 `website`；WAF 限速規則 `contact-form-rate-limit`（同 IP 10 秒 2 次） |

## 部署

Cloudflare Workers Builds 監看 `main`、根目錄 `workers/contact`，push 後自動 `npx wrangler deploy`。
**不要在 Dashboard 改路由或一般變數**，下次部署會被覆蓋；要改請改 `wrangler.jsonc`。

## 維運注意

- Entra App 的 Client Secret 有到期日，過期後表單會回「郵件服務驗證失敗」。到期前在 Entra 產生新 secret，
  再到 Dashboard 更新 `CLIENT_SECRET`。
- 修改收件人：改 `wrangler.jsonc` 的 `MAIL_TO`（逗號分隔）後 push。

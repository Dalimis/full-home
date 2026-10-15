# 目標架構

## 1. 設計原則

1. **官網不能因為 CMS 故障而掛掉。** 前台只讀「已發布、可快取」的公開 API；CMS 後台、資料庫或主機出問題時，官網照常顯示最後一次發布的內容。
2. **公開 API 與管理 API 完全分開。** 不同網址、不同驗證；前台 JavaScript 不會帶任何 token。
3. **既有網址不變。** `/`、`/investors/*`、`/files/{id}`、`/api/contact` 都保持相容。
4. **兩層驗證。** Cloudflare Access 決定「誰能連到後台」；CMS 自己的帳號與角色決定「能做什麼」。通過 Access **不等於**擁有 CMS 權限。
5. **Git 是設定的唯一來源。** 路由、變數、Schema 都在 repo；Dashboard 只放 secret。

## 2. 建議架構（方案 A：Payload on Cloudflare Workers）

```
瀏覽器
  │
Cloudflare CDN / WAF
  │
  ├─ www.full-home.com.tw/*                  Pages（現有前台，保留版型）
  │     └─ 前端 JS 讀取 ↓
  ├─ /api/public/*                            Worker「fullhome-public」（新）
  │     │  ‧只回傳 status = published 的資料
  │     │  ‧Cache API 快取 60 秒；CMS 發布時清快取
  │     │  ‧回傳格式與現有 /api/public/investors 相容
  │     └─ 讀 D1（CMS 資料庫，唯讀查詢）
  ├─ /files/{id}                              同上 Worker：舊 id → 對照表 → R2
  │
  ├─ cms.full-home.com.tw（或 /cms）          Cloudflare Access（Entra ID 或 OTP）
  │     └─ Worker「fullhome-payload」         Payload 3（Next.js on Workers）
  │           ├─ D1  fullhome-payload-db     新資料庫（不與舊 D1 共用）
  │           └─ R2  fullhome-files          同一個 bucket，新檔案用 cms/ 前綴
  │
  └─ /api/contact                             Worker「fullhome-contact」
        ├─ 寫入表單紀錄（D1，Payload 的 form-submissions 集合）
        └─ Graph sendMail 通知
```

說明：
- **公開讀取另開一支小 Worker**，而不是讓前台直接打 Payload 的 REST API。這樣可以：固定回傳格式（前台不用跟著 Payload 改版）、確保只露出已發布資料、加快取、在 Payload 故障時仍可回應。
- **Payload 後台放在子網域**（例如 `cms.full-home.com.tw`），與官網分開，Access 規則也比較單純。
- **R2 共用同一個 bucket**：舊檔案原地保留，不需要複製；新上傳的檔案放 `cms/` 前綴。

## 3. 替代架構（方案 B：Directus 自架）

```
官網（Pages，不變）
  │
/api/public/*  Worker「fullhome-public」
  │   ‧從 KV / D1 讀「發布快照」
  │
  └── 發布快照由 Directus Flow（webhook）推送進 Cloudflare
          ▲
Directus（Docker） ── PostgreSQL（同機 Docker 或公司 DB）
  │   ‧Storage：S3 driver → R2
  │   ‧SSO：OpenID → Entra ID（Team 方案以上）
  │
部署在：Linux VPS，或公司 VMware 上的 Linux VM
對外：Cloudflare Tunnel（不開防火牆連接埠）+ Cloudflare Access
```

關鍵差異：Directus 主機在公司或 VPS，**前台必須靠快照**，不能即時依賴它，否則公司斷網，官網的投資人資料就跟著消失。

### PostgreSQL vs SQL Server（若選 Directus）

| | PostgreSQL | SQL Server |
|---|---|---|
| Directus 支援 | ✅ 官方支援，社群主流 | ✅ 官方支援，使用者較少，遇到問題的參考資料少 |
| 授權 | 免費 | Express 免費但有 10 GB/資料庫上限；Standard 需購買授權 |
| 部署 | 與 Directus 同一個 Docker Compose 即可 | 通常沿用公司既有 SQL Server，需額外開放連線 |
| 備份 | `pg_dump` 排程 + 異地保存 | 可沿用公司既有備份機制 |
| 建議 | ✅ 優先 | 只有在公司要求統一用 SQL Server 時才考慮 |

## 4. 內容模型（Collections）

| Collection | 類型 | 對應舊資料 | 主要欄位 | 公開條件 |
|---|---|---|---|---|
| `company-profile` | Global（單例） | company_profile | 同現有欄位 | 全部公開 |
| `board-members` | Collection | board_members | type、name、title、representative、note、order、visible | visible = true |
| `documents` | Collection（upload） | documents | category、subcategory、rocYear、quarter、title、description、file、publishAt、visible、legacyId | visible 且 publishAt ≤ 現在 |
| `document-categories` | Collection | （新） | name、slug、order | — |
| `faqs` | Collection | faqs | question、answer(richText)、order、visible | visible = true |
| `media` | Collection（upload） | （新） | file、alt、caption、folder | 被已發布內容引用時 |
| `pages` | Collection（blocks + drafts） | （新） | slug、title、seo、blocks[] | status = published |
| `news` | Collection（drafts） | （新） | title、slug、category、cover、content、publishAt、pinned | status = published |
| `projects` | Collection（drafts） | （新） | name、location、status、description、features、gallery、progress、category、seo | status = published |
| `navigation` | Global | （新） | items[] | 全部公開 |
| `form-submissions` | Collection | （新） | type、payload(JSON)、ip_hash、createdAt、handledBy、handledAt | **不公開**；依保存期限自動刪除 |
| `users` | Auth collection | admin_users | email、name、roles[] | 不公開 |
| `audit-logs` | Collection | （新） | user、action、collection、docId、diff、at | 不公開、不可修改 |

角色（對應需求 F）：

| 角色 | 權限 |
|---|---|
| 超級管理員 | 全部，含使用者與角色管理 |
| 網站管理員 | 全部內容集合的 CRUD 與發布 |
| 內容編輯者 | 建立/編輯草稿；**不能**發布、不能刪除已發布內容 |
| 內容審核者 | 檢視草稿、發布或退回 |
| 唯讀檢視者 | 只能看 |

投資人揭露資料（company-profile、board-members、documents）建議限定「網站管理員」以上才能發布，避免誤發。

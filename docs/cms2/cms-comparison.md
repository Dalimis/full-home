# Phase 1：CMS 方案比較

> 授權與價格皆於 2026-10-15 查證，來源列在文末。價格可能變動，簽約前請再確認。

## 1. 先講結論

| 方案 | 一句話評價 |
|---|---|
| **A. Payload CMS 3（跑在 Cloudflare Workers + D1 + R2）** | **建議方案**。MIT 授權、免費，留在現有 Cloudflare 架構，不用另外維護伺服器。代價是**新增資料集合要改設定檔（程式碼）**。 |
| B. Directus（自架 Docker + PostgreSQL） | 功能最貼近需求清單（視覺化建立集合、欄位權限、Flows），但**達麗營收超過門檻，要付費**：免費版只有 3 個帳號、沒有 SSO；Team 方案約 **USD 5,988/年**。另外要自己維護伺服器與資料庫。 |
| C. NocoBase（自架 Docker + PostgreSQL） | 視覺化建立資料表最直覺，社群版 Apache-2.0 免費；但 SSO、審核流程需 Professional 版（**USD 8,000 一次性**）。定位偏「內部系統建構平台」，當公開網站 CMS 較不成熟。 |
| D. 繼續自建 Worker CMS | 成本最低，但要達到「後台建集合不用寫程式」等於自己重寫一套 CMS，**不建議**往這個方向擴充。 |

**關鍵取捨**：需求寫的是「新增普通功能時盡量不改原始碼」。
- 如果**建立新集合的人是你（IT）**，Payload 的「改一段設定 → push → 自動部署」通常 10–30 分鐘，可以接受，也最省錢、最好維運。
- 如果**要讓非技術同仁自己建立新集合**，就只能選 Directus 或 NocoBase，並接受授權費和伺服器維運成本。

## 2. 逐項比較

| 比較項目 | A. Payload on Workers | B. Directus 自架 | C. NocoBase 自架 | D. 自建 Worker |
|---|---|---|---|---|
| 與現有 Cloudflare 整合 | ★★★ 官方範本直接用 D1、R2 binding | ★★ 需 VPS/VM；R2 用 S3 相容驅動；前面可放 Cloudflare Tunnel | ★★ 同 Directus | ★★★ 現況 |
| 保留現有前台版型 | ★★★ 前台不動，改讀新 API | ★★★ 同左 | ★★ 公開讀取 API 較陽春 | ★★★ |
| 視覺化建立資料集合 | ✗ 在 `payload.config.ts` 定義 | ★★★ Data Studio 內建 | ★★★ 核心功能 | ✗ |
| 視覺化編輯內容 | ★★★ 成熟後台、富文字、區塊、即時預覽 | ★★★ | ★★ 偏表格/表單式 | ★ 目前的手寫後台 |
| 草稿 / 版本 / 排程發布 | ★★★ 內建 drafts、versions、scheduled publish | ★★ 需用 Flows 或狀態欄位實作 | ★★ 需工作流 | ✗ |
| 頁面區塊（Page Builder） | ★★★ `blocks` 欄位 + Live Preview | ★★ 可用 M2A 關聯做區塊，另有 Visual Editor | ★ | ✗ |
| 角色 / 欄位權限 | ★★★ 集合、欄位、資料列層級（用程式定義） | ★★★ 後台設定；但「Granular RBAC」在 Team 以上 | ★★★ | ★ 目前只有區塊層級 |
| 工作流程 / 自動化 | ★★ hooks + jobs queue（寫程式） | ★★★ Flows（免費版限 5 個） | ★★★ 工作流（審核需付費） | ✗ |
| API | REST + GraphQL + Local API | REST + GraphQL | REST | 手寫 |
| 檔案管理 | ★★★ Media 集合、圖片尺寸、R2 adapter | ★★★ 檔案庫、圖片轉換 | ★★ | ★ |
| 繁體中文後台 | 有多語系 i18n，**zh-TW 需 PoC 確認** | 有社群翻譯，需 PoC 確認 | 簡中完整，**繁中需 PoC 確認** | ★★★ |
| SSO（Entra ID） | 自建 auth strategy 或社群外掛；或沿用 Cloudflare Access 當第一層 | OpenID driver 支援 Entra；但 **Core 免費版不含 SSO** | Professional 版以上 | Cloudflare Access |
| 部署與備份 | 跟現在一樣：Git push 自動部署；D1 Time Travel + 匯出 | 自己管 Docker、PostgreSQL 備份、升級、OS 修補 | 同 Directus | 現況 |
| 自行維護難度 | 低（無伺服器） | 中高 | 中高 | 低，但功能擴充成本高 |
| 授權 | MIT | 2026 年新授權；免費 Core 有限制（見下） | Apache-2.0（2026 年起）；商業版另售 | 自有 |

## 3. 成本估算（年）

| 方案 | 授權 | 主機 | 估計年成本 | 備註 |
|---|---|---|---|---|
| 現況 | 0 | Workers Free | **約 0** | |
| A. Payload on Workers | 0 | Workers Paid USD 5/月 | **約 USD 60** | Payload 打包後體積大，預期需要 Paid 方案（PoC 確認）；D1/R2 量小，預期在免費額度內 |
| B1. Directus Core 自架 | 0 | VPS 約 USD 20–40/月（估） | **約 USD 240–480** | **硬上限 3 個帳號**、25 個集合、5 個 Flow、無 SSO。目前後台已有 5 個帳號 |
| B2. Directus Team 自架 | USD 499/月（年繳） | VPS（同上） | **約 USD 6,200–6,500** | 10 個 SSO 帳號、50 個集合 |
| B3. Directus Cloud（Core） | 0 | USD 99/月 | **約 USD 1,188** | 仍是 3 個帳號、無 SSO |
| C1. NocoBase 社群版自架 | 0 | VPS（同上） | **約 USD 240–480** | 介面需保留 NocoBase 版權資訊 |
| C2. NocoBase Professional | USD 8,000（一次性，含 1 年升級與支援） | VPS | **首年約 USD 8,300，之後約 USD 300/年** | SSO、審核流程 |
| D. 自建 | 0 | 0–60 | 0–60 | 開發人力另計 |

**公司自有 Windows Server 上的 Linux VM**（方案 B/C 的部署選項）：主機費用可省，但要考慮：
- 官網後台會依賴公司機房的電力、網路與 VMware 維運。
- 不要開對外連接埠，用 **Cloudflare Tunnel** 對外。
- 建議前台**不要即時依賴 CMS**：發布時把內容同步到 Cloudflare（D1/R2/KV），公司機房斷線時官網照常運作（見 architecture.md）。

## 4. 各方案的重點說明

### A. Payload CMS 3 on Cloudflare
- Cloudflare 與 Payload 在 2025-09 推出官方範本 `with-cloudflare-d1`，可一鍵部署到 Workers，使用 D1（Cloudflare 自寫的 adapter）與 R2（binding 版 storage adapter），也可透過 Hyperdrive 接 PostgreSQL。
- 2025 年被 Figma 收購後，官方表示 **MIT 授權與開源維持不變**。3.x 持續更新，4.0 於 2026-04 進入 beta。
- Payload Cloud 已不接受新註冊，所以只能自架。在 Workers 上就是「自架但不用管機器」。
- 風險：D1 adapter 不是 Payload 官方核心維護；Payload 4.0 升級路徑要觀察；在 Workers 上的打包大小與冷啟動需 PoC 實測。

### B. Directus
- 資料庫支援：PostgreSQL、MySQL、MariaDB、MS SQL Server、SQLite、Oracle、CockroachDB。
- **授權在 2026 年改版**：官網授權頁現為 Monospace Sustainable Core License（MSCL-1.0），定價頁改為 Core / Team / Enterprise 三級。「Open Innovation Grant」（年營收低於 USD 500 萬**且**員工少於 50 人）才能免費使用完整功能，**達麗與馥鴻不符合**。
- SSO：支援 OpenID（可接 Entra ID，能自動建立帳號並指定預設角色），但定價頁註明 **Core 不含 SSO，也不能單獨加購**。
- R2：使用 S3 storage driver，設定 R2 的 endpoint 即可。
- 結論：產品最符合需求清單，但以馥鴻目前的規模（一個投資人網站、5 個後台帳號），年費 USD 6,000 以上 + 伺服器維運並不划算。**除非 CMS 要給集團多個網站共用**，成本才攤得開。

### C. NocoBase
- 2026 年從 AGPL-3.0 改為 **Apache-2.0**，社群版可免費商用，但需保留介面上的版權資訊。
- 定價：Standard USD 800、Professional USD 8,000（一次性，含 1 年升級與支援）、Enterprise 洽詢。SSO（OIDC/SAML/LDAP）與審核流程在 Professional 以上。
- 擅長：內部資料管理、表單、工作流。如果公司其他內部系統（例如工地 App 後台、郵件寄送申請）也想用 no-code 平台，NocoBase 的價值會比單看官網高。
- 不擅長：對外公開網站的內容發布（草稿/排程/SEO/頁面區塊/媒體）。

### D. 繼續自建
- 現有 Worker 已具備 Access、JWT、區塊權限，短期內**修補 F1–F8 的問題**仍然值得做，不管最後選哪個方案。
- 但要做到「視覺化建立集合、欄位權限、工作流」，就是重造一套 CMS，不建議。

## 5. 建議的決策方式

1. 先回答 current-system.md 的 **M4、M5、M6**（誰建集合、服務幾個網站、預算）。
2. 依答案選擇：
   - IT 建集合、只服務馥鴻、預算低 → **A. Payload on Workers**
   - 非技術人員要自己建集合，或集團多站共用 → **B. Directus Team**（或先用 B1 Core 版 PoC）
   - 主要需求其實是內部資料系統 → **C. NocoBase**
3. 對選定方案做 **2–3 天的 PoC**（Phase 2），確認繁中後台、D1/R2 整合、權限與部署，再決定是否正式導入。

## 來源

- Directus 定價：https://directus.com/pricing
- Directus 授權：https://directus.com/license
- Directus 2023 改用 BSL 的說明（舊制 USD 500 萬門檻）：https://directus.com/resources/why-we-are-relicensing-directus
- Directus SSO 設定：https://directus.com/docs/configuration/auth-sso
- Directus 支援的資料庫：https://community.directus.com/t/what-database-backends-are-supported-in-directus/40/2
- Cloudflare：Payload CMS on Workers（2025-09-30）：https://blog.cloudflare.com/payload-cms-workers/
- Payload 授權與版本現況：https://www.oflight.co.jp/en/columns/payload-cms-nextjs-figma-2026
- NocoBase 授權調整（2026-02）：https://www.nocobase.com/en/blog/pricing-adjustment-202602
- NocoBase 定價：https://www.nocobase.com/pricing
- D1 Time Travel：https://developers.cloudflare.com/d1/reference/time-travel/

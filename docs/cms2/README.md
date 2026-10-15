# 馥鴻建設官網 CMS 2.0：Phase 0 + Phase 1 規劃

> 狀態：規劃階段。**沒有修改正式網站、D1、R2、DNS、Access 或 Worker 路由。**
> 文件位於 `cms2-planning` 分支，未合併到 main。

| 文件 | 內容 |
|---|---|
| [current-system.md](current-system.md) | Phase 0：架構、API、資料表、程式碼問題、安全風險、尚缺資料 |
| [cms-comparison.md](cms-comparison.md) | Phase 1：Payload / Directus / NocoBase / 自建 比較與成本 |
| [architecture.md](architecture.md) | 目標架構、內容模型、角色設計 |
| [migration-plan.md](migration-plan.md) | 遷移步驟、切換策略、回復方案、驗收清單 |
| [security-plan.md](security-plan.md) | 現在就該修的項目、新 CMS 安全要求 |

## 決策更新（2026-10-15）

- D2：**只服務馥鴻**。D3：**預算為 0，必須免費**。
- 因此 Directus（Team 年費、Core 限 3 帳號）與 Payload（Workers Free 每次請求 CPU 上限 10 ms，Next.js 後台實務上需 Workers Paid）都不符合。
- **改採方案：在現有免費架構上擴充自建 CMS（CMS 1.5）**：
  1. 先修 security-plan.md 的 P0 項目。
  2. 把後台頁面從 `adminHtml()` 字串拆成獨立的靜態檔，降低修改風險。
  3. 建立「設定檔驅動」的通用資料模組：新增簡單的內容類型（最新消息、建案等）只要加一段欄位定義，後台表單、列表、API、權限自動產生，不必再手寫 CRUD。
  4. 頁面內容（首頁各區塊、SEO）逐步改為由後台資料驅動。
- 以下原始摘要保留作為比較紀錄。

## 重點摘要

1. **Directus 不建議作為首選。** 2026 年改版授權後，達麗/馥鴻不符合免費資格。免費 Core 版只有 3 個帳號、無 SSO；要 SSO 和 10 個帳號需 Team 方案，約 USD 5,988/年，另外還要自己維護伺服器和 PostgreSQL。以一個投資人網站、5 個後台帳號的規模來說不划算，除非要給集團多個網站共用。
2. **建議方案：Payload CMS 3，直接跑在 Cloudflare Workers + D1 + R2。** MIT 授權免費，Cloudflare 有官方範本，不用另外維護主機，Git push 就部署，維運方式跟現在一樣。成本預估是 Workers Paid 每月 USD 5。
3. **唯一的取捨是**：Payload 的資料集合定義在程式碼裡。新增集合要改設定檔並部署，大約 10–30 分鐘。如果非技術同仁要自己建立集合，就要改選 Directus 或 NocoBase。
4. **不管選哪個方案，現有系統都有幾個問題值得先修**：上傳失敗會留下孤兒檔案、刪除順序不對、聯絡表單沒有留存紀錄、檔案內容沒有驗證、沒有稽核紀錄、R2 沒有備份。見 security-plan.md 第 1 節。
5. **架構原則**：前台只讀一支獨立的公開 API Worker，不直接依賴 CMS。CMS 故障時官網照常運作，前台的網址與 JSON 格式也都保持不變。

## 需要你決定的事

| # | 問題 | 影響 |
|---|---|---|
| D1 | 之後由**誰**建立新的資料集合？你（IT），還是行銷或業務同仁？ | 決定 Payload（code-first）或 Directus/NocoBase（no-code） |
| D2 | CMS 只服務馥鴻，還是也要給達麗、寶信等網站用？ | 多站共用時，Directus 的授權費才攤得開 |
| D3 | 預算：可接受的年費或一次性費用上限？ | — |
| D4 | 是否同意升級 Workers Paid（USD 5/月）？ | Payload on Workers 的前提 |
| D5 | security-plan 的 P0 項目要不要先在現有系統修？ | 可以馬上做，和 CMS 2.0 互不影響 |

## 建議的下一步

1. 你回覆 D1–D5。
2. 補齊 current-system.md 第 7 節的尚缺資料，特別是 M1（D1 實際 schema）。
3. Phase 2 PoC（2–3 天）：在**獨立的測試 Worker、測試 D1、R2 測試前綴**上建立 Payload，包含公司資料、董事、文件三個集合，以及基本角色與公開 API。確認繁中後台、Workers 打包大小與冷啟動、Access 串接。**不碰正式站。**
4. PoC 結果出來後，再決定是否進入 Phase 3。

## 預計目錄（Phase 2 起）

```
full-home/
├─ site/                    現有前台（Phase 3 才調整資料來源）
├─ workers/
│  ├─ cms/                  現有 CMS（遷移完成且穩定 30 天後才退役）
│  ├─ contact/              表單（加入提交紀錄）
│  ├─ public-api/           新：公開讀取 API（相容現有 JSON 格式）
│  └─ payload/              新：Payload CMS（Next.js on Workers）
├─ scripts/
│  ├─ backup-d1.sh
│  ├─ backup-r2.sh
│  └─ migrate-legacy.ts     舊 D1 → 新 CMS 匯入（可重複執行）
└─ docs/cms2/               本規劃文件
```

所有 token、密碼、連線字串只放 Cloudflare secret 或本機 `.dev.vars`（已在 .gitignore），不進 repo。

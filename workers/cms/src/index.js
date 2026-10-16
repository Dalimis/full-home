export default {
  // 每日排程（wrangler.jsonc triggers.crons）：備份 + 清理過期表單紀錄
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMaintenance(env, "cron"));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    // ===== Admin canonical redirect =====
    // admin.html、/admin、沒有 www 的網址，全部統一到 www /admin/
    if (
      path === "/admin.html" ||
      path === "/admin" ||
      path === "/admin/"
    ) {
      if (
        url.hostname !== "www.full-home.com.tw" ||
        path !== "/admin/"
      ) {
        return Response.redirect(
          "https://www.full-home.com.tw/admin/",
          302
        );
      }
    }
    // ===== 第二層防護：Worker 自行驗證 Cloudflare Access JWT =====
    // Access 設定若漏設路徑、或被誤刪，後台與 admin API 仍會被擋下。
    const isAdminArea =
      path === "/admin/" || path.startsWith("/api/admin/");

    let auth = null;

    if (isAdminArea) {
      auth = await verifyAccess(request, env);
      if (!auth.ok) {
        console.warn("Access JWT rejected:", auth.reason, path);
        return path.startsWith("/api/")
          ? json({ ok: false, message: "未授權，請重新登入。" }, 401)
          : new Response("Unauthorized", { status: 401 });
      }

      // 寫入類請求必須來自本站頁面（防 CSRF）
      if (path.startsWith("/api/admin/") && request.method !== "GET") {
        const origin = request.headers.get("Origin");
        if (origin !== "https://www.full-home.com.tw") {
          return json({ ok: false, message: "來源不允許。" }, 403);
        }
        console.log("admin write", request.method, path, auth.email);
      }
    }

    // ===== 第三層：後台帳號權限（誰可以改哪些區塊）=====
    let me = null;

    if (path.startsWith("/api/admin/")) {
      const authEmail = auth.email;

      try {
        me = await loadAdminUser(env, authEmail);
      } catch (error) {
        console.error("load admin user failed:", error);
        return json({ ok: false, message: "權限資料讀取失敗，請稍後再試。" }, 500);
      }

      if (!me) {
        return json(
          { ok: false, message: `此帳號（${authEmail}）尚未開通後台權限，請聯絡系統管理員。` },
          403
        );
      }

      const need = requiredPermission(path);
      if (need && !me.permissions.includes(need)) {
        return json(
          { ok: false, message: `您沒有「${PERMISSION_LABELS[need]}」的權限。` },
          403
        );
      }
    }

    // ===== 稽核紀錄：所有後台寫入操作（誰、何時、做了什麼、結果）=====
    // 編輯鎖的心跳每分鐘一次，不寫進操作紀錄
    if (me && request.method !== "GET" && !path.startsWith("/api/admin/content/lock")) {
      const summary = await auditSummary(request);
      const response = await handle();
      ctx?.waitUntil?.(writeAudit(env, me.email, request.method, path, response.status, summary));
      return response;
    }

    return handle();

    async function handle() {
    try {
      if (path === "/admin" || path === "/admin/") {
        return htmlResponse(adminHtml());
      }

      // 首頁：把後台編輯過的文字/圖片套進 HTML（HTMLRewriter，搜尋引擎也看得到）
      if (path === "/" && request.method === "GET") {
        ctx?.passThroughOnException?.();
        // 後台專用的檢視模式（必須已通過 Access 登入且有「頁面內容」權限）：
        //   ?cms-edit=1     編輯器：正式內容 + 草稿，隱藏的框框也輸出（標記 data-cms-hidden）並附上目前樣式
        //   ?cms-preview=1  預覽草稿：正式內容 + 草稿，看起來和上線後一樣
        //   ?cms-version=ID 預覽某個歷史版本
        const wants = ["cms-edit", "cms-preview", "cms-version"].some((k) => url.searchParams.has(k));
        let viewer = null;
        if (wants) {
          const acc = await verifyAccess(request, env);
          if (acc.ok) {
            const u = await loadAdminUser(env, acc.email).catch(() => null);
            if (u && u.permissions.includes("pages")) viewer = u;
          }
        }
        return renderHomepage(request, env, {
          edit: !!viewer && url.searchParams.has("cms-edit"),
          draft: !!viewer && (url.searchParams.has("cms-edit") || url.searchParams.has("cms-preview")),
          version: viewer && url.searchParams.has("cms-version") ? Number(url.searchParams.get("cms-version")) || 0 : 0,
          banner: viewer ? (url.searchParams.has("cms-preview") ? "草稿預覽（尚未上線）" : url.searchParams.has("cms-version") ? "歷史版本預覽 #" + url.searchParams.get("cms-version") : "") : ""
        });
      }

      // 搜尋引擎：sitemap 依後台資料的最後更新時間產生；Worker 失敗時由 Pages 的靜態檔接手
      if (path === "/sitemap.xml" && request.method === "GET") {
        ctx?.passThroughOnException?.();
        return renderSitemap(env);
      }

      if (path === "/robots.txt" && request.method === "GET") {
        return new Response(ROBOTS_TXT, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }
        });
      }

      if (path.startsWith("/media/") && request.method === "GET") {
        return serveMedia(path, env);
      }

      if (path === "/api/public/investors" && request.method === "GET") {
        return publicInvestors(env);
      }

      if (path.startsWith("/files/") && request.method === "GET") {
        return servePublicFile(path, env);
      }

      if (path === "/api/admin/bootstrap" && request.method === "GET") {
        return adminBootstrap(env, me);
      }

      if (path === "/api/admin/company" && request.method === "PUT") {
        return saveCompany(request, env);
      }

      if (path === "/api/admin/board" && request.method === "POST") {
        return createBoardMember(request, env);
      }

      const boardMatch = path.match(/^\/api\/admin\/board\/(\d+)$/);

      if (boardMatch && request.method === "PUT") {
        return updateBoardMember(
          request,
          env,
          Number(boardMatch[1])
        );
      }

      if (boardMatch && request.method === "DELETE") {
        return deleteBoardMember(
          env,
          Number(boardMatch[1])
        );
      }

      if (
        path === "/api/admin/documents" &&
        request.method === "POST"
      ) {
        return uploadDocument(request, env);
      }

      const docMatch =
        path.match(
          /^\/api\/admin\/documents\/(\d+)$/
        );

      if (
        docMatch &&
        request.method === "PUT"
      ) {
        return updateDocument(
          request,
          env,
          Number(docMatch[1])
        );
      }

      // 更換檔案（保留同一筆文件、同一個 /files/{id} 連結）
      const docFileMatch = path.match(/^\/api\/admin\/documents\/(\d+)\/file$/);

      if (docFileMatch && request.method === "POST") {
        return replaceDocumentFile(request, env, Number(docFileMatch[1]));
      }

      // 後台預覽（隱藏文件也看得到）
      if (docFileMatch && request.method === "GET") {
        return serveDocumentAdmin(env, Number(docFileMatch[1]));
      }

      if (
        docMatch &&
        request.method === "DELETE"
      ) {
        return deleteDocument(
          env,
          Number(docMatch[1])
        );
      }

      // ===== 聯絡表單紀錄 =====
      if (path === "/api/admin/contacts" && request.method === "GET") {
        return listContacts(url, env);
      }

      if (path === "/api/admin/contacts/export.csv" && request.method === "GET") {
        return exportContactsCsv(url, env, me);
      }

      const contactMatch = path.match(/^\/api\/admin\/contacts\/(\d+)$/);

      if (contactMatch && request.method === "PUT") {
        return updateContact(request, env, me, Number(contactMatch[1]));
      }

      if (contactMatch && request.method === "DELETE") {
        return deleteContact(env, me, Number(contactMatch[1]));
      }

      // ===== 系統備份 =====
      if (path === "/api/admin/backups" && request.method === "GET") {
        return listBackups(env);
      }

      if (path === "/api/admin/backups/run" && request.method === "POST") {
        return json({ ok: true, result: await runMaintenance(env, me.email) });
      }

      if (path === "/api/admin/backups/test-alert" && request.method === "POST") {
        const r = await sendAlert(env, { issues: [`這是測試通知（由 ${me.email} 從後台發送），收到代表異常通知功能正常。`] });
        return json({ ok: r === "sent", message: r === "sent" ? "測試通知已寄出。" : "寄送失敗：" + r }, r === "sent" ? 200 : 502);
      }

      if (path === "/api/admin/backups/download" && request.method === "GET") {
        return downloadBackup(url, env);
      }

      // ===== 頁面內容 =====
      if (path === "/api/admin/content/lock" && request.method === "GET") {
        return getLock(env, me);
      }

      if (path === "/api/admin/content/lock" && request.method === "POST") {
        return acquireLock(request, env, me);
      }

      if (path === "/api/admin/content/lock/release" && request.method === "POST") {
        return releaseLock(env, me);
      }

      // 會改到草稿或正式內容的操作，都要先拿到編輯鎖（同一時間只有一個人）
      if (
        path.startsWith("/api/admin/content") && request.method !== "GET" &&
        path !== "/api/admin/content/image" && !/\/baseline$/.test(path)
      ) {
        const busy = await requireEditLock(env, me);
        if (busy) return busy;
      }

      if (path === "/api/admin/content" && request.method === "PUT") {
        return saveSiteContent(request, env, me);
      }

      if (path === "/api/admin/content/draft" && request.method === "GET") {
        return getDraft(env);
      }

      if (path === "/api/admin/content/draft" && request.method === "PUT") {
        return saveDraft(request, env, me);
      }

      if (path === "/api/admin/content/draft" && request.method === "DELETE") {
        return discardDraft(env);
      }

      if (path === "/api/admin/content/publish" && request.method === "POST") {
        return publishDraft(request, env, me);
      }

      if (path === "/api/admin/content/versions" && request.method === "GET") {
        return listVersions(env);
      }

      const versionMatch = path.match(/^\/api\/admin\/content\/versions\/(\d+)\/(restore|baseline)$/);

      if (versionMatch && request.method === "POST") {
        return versionMatch[2] === "restore"
          ? restoreVersion(env, me, Number(versionMatch[1]))
          : setBaseline(request, env, me, Number(versionMatch[1]));
      }

      if (path === "/api/admin/content/history" && request.method === "GET") {
        return listContentHistory(url, env);
      }

      if (path === "/api/admin/content/revert" && request.method === "POST") {
        return revertContentHistory(request, env, me);
      }

      if (path === "/api/admin/audit" && request.method === "GET") {
        return listAudit(url, env);
      }

      if (path === "/api/admin/content/image" && request.method === "POST") {
        return uploadSiteImage(request, env);
      }

      // ===== 權限管理 =====
      if (path === "/api/admin/users" && request.method === "POST") {
        return createAdminUser(request, env, me);
      }

      const userMatch = path.match(/^\/api\/admin\/users\/(\d+)$/);

      if (userMatch && request.method === "PUT") {
        return updateAdminUser(request, env, me, Number(userMatch[1]));
      }

      if (userMatch && request.method === "DELETE") {
        return deleteAdminUser(env, me, Number(userMatch[1]));
      }

      // ===== 常見問題 FAQ =====
      if (path === "/api/admin/faqs" && request.method === "POST") {
        return createFaq(request, env);
      }

      const faqMatch = path.match(/^\/api\/admin\/faqs\/(\d+)$/);

      if (faqMatch && request.method === "PUT") {
        return updateFaq(request, env, Number(faqMatch[1]));
      }

      if (faqMatch && request.method === "DELETE") {
        return deleteFaq(env, Number(faqMatch[1]));
      }

      // 不是 CMS 負責的路徑（官網其他頁面、CSS、JS、圖片）：原封不動交給 Pages
      if (!path.startsWith("/api/")) {
        return fetch(request);
      }

      return json(
        {
          ok: false,
          message: "Not found"
        },
        404
      );

    } catch (error) {

      console.error(
        "CMS worker error:",
        error
      );

      return json(
        {
          ok: false,
          message:
            "系統發生錯誤，請稍後再試。"
        },
        500
      );
    }
    }
  }
};


async function publicInvestors(env) {

  const company =
    await env.DB.prepare(
      "SELECT * FROM company_profile WHERE id = 1"
    ).first();

  const board =
    await env.DB.prepare(
      `
      SELECT
        id,
        member_type,
        name,
        title,
        representative,
        note,
        sort_order
      FROM board_members
      WHERE is_public = 1
      ORDER BY
        CASE member_type
          WHEN '董事' THEN 1
          ELSE 2
        END,
        sort_order ASC,
        id ASC
      `
    ).all();

  const documents =
    await env.DB.prepare(
      `
      SELECT
        id,
        category,
        subcategory,
        year,
        quarter,
        title,
        description,
        file_name,
        file_size,
        mime_type,
        sort_order,
        published_at
      FROM documents
      WHERE is_public = 1
      ORDER BY
        year DESC,
        sort_order ASC,
        id DESC
      `
    ).all();

  return json({
    ok: true,

    company:
      company || null,

    board:
      board.results || [],

    documents:
      (documents.results || []).map(
        (d) => ({
          ...d,
          file_url:
            `/files/${d.id}`
        })
      ),

    faqs:
      await listFaqs(env, true)
  });
}


async function adminBootstrap(env, me) {

  const company =
    await env.DB.prepare(
      "SELECT * FROM company_profile WHERE id = 1"
    ).first();

  const board =
    await env.DB.prepare(
      `
      SELECT *
      FROM board_members
      ORDER BY
        CASE member_type
          WHEN '董事' THEN 1
          ELSE 2
        END,
        sort_order ASC,
        id ASC
      `
    ).all();

  const documents =
    await env.DB.prepare(
      `
      SELECT *
      FROM documents
      ORDER BY
        year DESC,
        sort_order ASC,
        id DESC
      `
    ).all();

  return json({
    ok: true,

    company:
      company || null,

    board:
      board.results || [],

    documents:
      documents.results || [],

    faqs:
      await listFaqs(env, false),

    me,

    content_keys:
      me && me.permissions.includes("pages")
        ? [...(await loadSiteContent(env)).keys()]
        : [],

    users:
      me && me.permissions.includes("users")
        ? await listAdminUsers(env)
        : [],

    super_admins:
      me && me.permissions.includes("users")
        ? superAdmins(env)
        : [],

    permission_labels:
      PERMISSION_LABELS
  });
}


async function saveCompany(
  request,
  env
) {

  const body =
    await request.json();

  const values = {

    company_name:
      clean(
        body.company_name,
        120
      ),

    company_name_en:
      clean(
        body.company_name_en,
        180
      ),

    stock_code:
      clean(
        body.stock_code,
        20
      ),

    phone:
      clean(
        body.phone,
        40
      ),

    address:
      clean(
        body.address,
        250
      ),

    chairman:
      clean(
        body.chairman,
        80
      ),

    general_manager:
      clean(
        body.general_manager,
        80
      ),

    spokesperson:
      clean(
        body.spokesperson,
        80
      ),

    spokesperson_title:
      clean(
        body.spokesperson_title,
        80
      ),

    spokesperson_phone:
      clean(
        body.spokesperson_phone,
        80
      ),

    spokesperson_email:
      clean(
        body.spokesperson_email,
        180
      ),

    deputy_spokesperson:
      clean(
        body.deputy_spokesperson,
        80
      ),

    deputy_spokesperson_title:
      clean(
        body.deputy_spokesperson_title,
        80
      ),

    deputy_spokesperson_phone:
      clean(
        body.deputy_spokesperson_phone,
        80
      ),

    deputy_spokesperson_email:
      clean(
        body.deputy_spokesperson_email,
        180
      ),

    transfer_agent:
      clean(
        body.transfer_agent,
        180
      ),

    transfer_agent_phone:
      clean(
        body.transfer_agent_phone,
        80
      ),

    transfer_agent_address:
      clean(
        body.transfer_agent_address,
        250
      )
  };


  if (!values.company_name) {

    return json(
      {
        ok: false,
        message:
          "公司名稱不可空白。"
      },
      400
    );
  }


  await env.DB.prepare(
    `
    INSERT INTO company_profile (

      id,

      company_name,
      company_name_en,
      stock_code,
      phone,
      address,

      chairman,
      general_manager,

      spokesperson,
      spokesperson_title,
      spokesperson_phone,
      spokesperson_email,

      deputy_spokesperson,
      deputy_spokesperson_title,
      deputy_spokesperson_phone,
      deputy_spokesperson_email,

      transfer_agent,
      transfer_agent_phone,
      transfer_agent_address,

      updated_at
    )

    VALUES (

      1,

      ?, ?, ?, ?, ?,

      ?, ?,

      ?, ?, ?, ?,

      ?, ?, ?, ?,

      ?, ?, ?,

      CURRENT_TIMESTAMP
    )

    ON CONFLICT(id)
    DO UPDATE SET

      company_name =
        excluded.company_name,

      company_name_en =
        excluded.company_name_en,

      stock_code =
        excluded.stock_code,

      phone =
        excluded.phone,

      address =
        excluded.address,

      chairman =
        excluded.chairman,

      general_manager =
        excluded.general_manager,

      spokesperson =
        excluded.spokesperson,

      spokesperson_title =
        excluded.spokesperson_title,

      spokesperson_phone =
        excluded.spokesperson_phone,

      spokesperson_email =
        excluded.spokesperson_email,

      deputy_spokesperson =
        excluded.deputy_spokesperson,

      deputy_spokesperson_title =
        excluded.deputy_spokesperson_title,

      deputy_spokesperson_phone =
        excluded.deputy_spokesperson_phone,

      deputy_spokesperson_email =
        excluded.deputy_spokesperson_email,

      transfer_agent =
        excluded.transfer_agent,

      transfer_agent_phone =
        excluded.transfer_agent_phone,

      transfer_agent_address =
        excluded.transfer_agent_address,

      updated_at =
        CURRENT_TIMESTAMP
    `
  )
    .bind(

      values.company_name,
      values.company_name_en,
      values.stock_code,
      values.phone,
      values.address,

      values.chairman,
      values.general_manager,

      values.spokesperson,
      values.spokesperson_title,
      values.spokesperson_phone,
      values.spokesperson_email,

      values.deputy_spokesperson,
      values.deputy_spokesperson_title,
      values.deputy_spokesperson_phone,
      values.deputy_spokesperson_email,

      values.transfer_agent,
      values.transfer_agent_phone,
      values.transfer_agent_address
    )
    .run();


  return json({
    ok: true,
    message:
      "公司資料已更新。"
  });
}


async function createBoardMember(
  request,
  env
) {

  const body =
    await request.json();

  const member =
    normalizeBoard(body);


  if (
    !member.name ||
    ![
      "董事",
      "獨立董事"
    ].includes(
      member.member_type
    )
  ) {

    return json(
      {
        ok: false,
        message:
          "請填寫正確的董事類型與姓名。"
      },
      400
    );
  }


  const result =
    await env.DB.prepare(
      `
      INSERT INTO board_members (

        member_type,
        name,
        title,
        representative,
        note,
        sort_order,
        is_public,

        created_at,
        updated_at
      )

      VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      `
    )
      .bind(

        member.member_type,
        member.name,
        member.title,
        member.representative,
        member.note,
        member.sort_order,
        member.is_public
      )
      .run();


  return json({

    ok: true,

    id:
      result.meta?.last_row_id,

    message:
      "董事資料已新增。"
  });
}


async function updateBoardMember(
  request,
  env,
  id
) {

  const body =
    await request.json();

  const member =
    normalizeBoard(body);


  if (
    !member.name ||
    ![
      "董事",
      "獨立董事"
    ].includes(
      member.member_type
    )
  ) {

    return json(
      {
        ok: false,
        message:
          "請填寫正確的董事類型與姓名。"
      },
      400
    );
  }


  await env.DB.prepare(
    `
    UPDATE board_members

    SET

      member_type = ?,
      name = ?,
      title = ?,
      representative = ?,
      note = ?,

      sort_order = ?,
      is_public = ?,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
    `
  )
    .bind(

      member.member_type,
      member.name,
      member.title,
      member.representative,
      member.note,
      member.sort_order,
      member.is_public,
      id
    )
    .run();


  return json({
    ok: true,
    message:
      "董事資料已更新。"
  });
}


async function deleteBoardMember(
  env,
  id
) {

  await env.DB.prepare(
    "DELETE FROM board_members WHERE id = ?"
  )
    .bind(id)
    .run();


  return json({
    ok: true,
    message:
      "董事資料已刪除。"
  });
}
async function uploadDocument(request, env) {
  const form = await request.formData();

  const category = clean(form.get("category"), 80);
  const subcategory = clean(form.get("subcategory"), 120);
  const year = clean(form.get("year"), 10);
  const quarter = clean(form.get("quarter"), 20);
  const title = clean(form.get("title"), 250);
  const description = clean(form.get("description"), 1500);
  const sort_order = toInt(form.get("sort_order"), 0);
  const is_public = String(form.get("is_public")) === "false" ? 0 : 1;
  const file = form.get("file");

  if (!category || !title || !(file instanceof File)) {
    return json(
      {
        ok: false,
        message: "分類、標題與檔案為必填。"
      },
      400
    );
  }

  const originalName = clean(file.name, 220);

  const ext = originalName.includes(".")
    ? originalName
        .split(".")
        .pop()
        .toLowerCase()
    : "";

  const allowedExtensions = new Set([
    "pdf",
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "jpg",
    "jpeg",
    "png",
    "webp"
  ]);

  if (!allowedExtensions.has(ext)) {
    return json(
      {
        ok: false,
        message: "不支援此檔案格式。"
      },
      400
    );
  }

  // 依副檔名決定 Content-Type，不信任瀏覽器送來的 file.type
  // （避免把 HTML 偽裝成 PDF 上傳後，在官網網域被當成網頁執行）
  const mimeType = MIME_BY_EXT[ext] || "application/octet-stream";

  const maxBytes =
    25 * 1024 * 1024;

  if (file.size > maxBytes) {
    return json(
      {
        ok: false,
        message: "單一檔案上限為 25 MB。"
      },
      400
    );
  }

  // 檢查檔案內容的檔頭，副檔名必須與實際格式相符（擋下改副檔名的偽裝檔）
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!fileMatchesExtension(bytes, ext)) {
    return json(
      {
        ok: false,
        message: "檔案內容與副檔名不符，請確認檔案是否正確。"
      },
      400
    );
  }

  const safeCategory =
    slug(category) || "misc";

  const safeYear =
    /^\d{4}$/.test(year)
      ? year
      : "other";

  const key =
    `${safeCategory}/${safeYear}/${Date.now()}-${crypto.randomUUID()}.${ext}`;

  await env.FILES.put(
    key,
    bytes,
    {
      httpMetadata: {
        contentType: mimeType
      },

      customMetadata: {
        originalName
      }
    }
  );

  // 資料庫寫入失敗時，刪除剛上傳的檔案，避免留下孤兒檔案
  let result;
  try {
    result =
    await env.DB.prepare(
      `
      INSERT INTO documents (

        category,
        subcategory,
        year,
        quarter,
        title,
        description,

        file_name,
        file_key,
        file_size,
        mime_type,

        sort_order,
        is_public,

        published_at,
        created_at,
        updated_at
      )

      VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      `
    )
      .bind(
        category,
        subcategory,
        year,
        quarter,
        title,
        description,

        originalName,
        key,
        file.size,
        mimeType,

        sort_order,
        is_public
      )
      .run();
  } catch (error) {
    console.error("document insert failed, removing uploaded object:", key, error);
    await env.FILES.delete(key).catch((e) => console.error("orphan cleanup failed:", key, e));
    throw error;
  }

  return json({
    ok: true,

    id:
      result.meta?.last_row_id,

    message:
      "文件已上傳。"
  });
}


async function updateDocument(
  request,
  env,
  id
) {

  const body =
    await request.json();

  const category =
    clean(
      body.category,
      80
    );

  const subcategory =
    clean(
      body.subcategory,
      120
    );

  const year =
    clean(
      body.year,
      10
    );

  const quarter =
    clean(
      body.quarter,
      20
    );

  const title =
    clean(
      body.title,
      250
    );

  const description =
    clean(
      body.description,
      1500
    );

  const sort_order =
    toInt(
      body.sort_order,
      0
    );

  const is_public =
    body.is_public === false ||
    Number(body.is_public) === 0
      ? 0
      : 1;


  if (
    !category ||
    !title
  ) {

    return json(
      {
        ok: false,
        message:
          "分類與標題不可空白。"
      },
      400
    );
  }


  await env.DB.prepare(
    `
    UPDATE documents

    SET
      category = ?,
      subcategory = ?,
      year = ?,
      quarter = ?,
      title = ?,
      description = ?,
      sort_order = ?,
      is_public = ?,

      updated_at =
        CURRENT_TIMESTAMP

    WHERE id = ?
    `
  )
    .bind(
      category,
      subcategory,
      year,
      quarter,
      title,
      description,
      sort_order,
      is_public,
      id
    )
    .run();


  return json({
    ok: true,
    message:
      "文件資料已更新。"
  });
}


const DOC_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "jpg", "jpeg", "png", "webp"]);

// 檢查文件檔案：副檔名、大小、檔頭；回傳 { error } 或 { ext, mimeType, bytes, originalName }
async function checkDocumentFile(file) {
  if (!(file instanceof File)) return { error: "請選擇檔案。" };
  const originalName = clean(file.name, 220);
  const ext = originalName.includes(".") ? originalName.split(".").pop().toLowerCase() : "";
  if (!DOC_EXTENSIONS.has(ext)) return { error: "不支援此檔案格式。" };
  if (file.size > 25 * 1024 * 1024) return { error: "單一檔案上限為 25 MB。" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!fileMatchesExtension(bytes, ext)) return { error: "檔案內容與副檔名不符，請確認檔案是否正確。" };
  return { ext, mimeType: MIME_BY_EXT[ext] || "application/octet-stream", bytes, originalName };
}

async function replaceDocumentFile(request, env, id) {
  const doc = await env.DB.prepare("SELECT id, category, year, file_key FROM documents WHERE id = ?").bind(id).first();
  if (!doc) return json({ ok: false, message: "找不到這份文件。" }, 404);

  const form = await request.formData();
  const checked = await checkDocumentFile(form.get("file"));
  if (checked.error) return json({ ok: false, message: checked.error }, 400);

  const safeYear = /^\d{4}$/.test(doc.year || "") ? doc.year : "other";
  const key = `${slug(doc.category) || "misc"}/${safeYear}/${Date.now()}-${crypto.randomUUID()}.${checked.ext}`;

  await env.FILES.put(key, checked.bytes, {
    httpMetadata: { contentType: checked.mimeType },
    customMetadata: { originalName: checked.originalName }
  });

  try {
    await env.DB.prepare(`
      UPDATE documents
      SET file_name = ?, file_key = ?, file_size = ?, mime_type = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(checked.originalName, key, checked.bytes.byteLength, checked.mimeType, id).run();
  } catch (error) {
    console.error("document file update failed, removing new object:", key, error);
    await env.FILES.delete(key).catch(() => {});
    throw error;
  }

  if (doc.file_key && doc.file_key !== key) {
    try {
      await env.FILES.delete(doc.file_key);
    } catch (error) {
      console.error("old file delete failed (orphan left):", doc.file_key, error);
    }
  }

  return json({ ok: true, message: "檔案已更換，連結不變。" });
}

async function serveDocumentAdmin(env, id) {
  const doc = await env.DB.prepare("SELECT file_key, file_name FROM documents WHERE id = ?").bind(id).first();
  if (!doc?.file_key) return new Response("Not found", { status: 404 });
  const object = await env.FILES.get(doc.file_key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(doc.file_name || "document")}`);
  return new Response(object.body, { headers });
}

async function deleteDocument(
  env,
  id
) {

  const doc =
    await env.DB.prepare(
      `
      SELECT file_key
      FROM documents
      WHERE id = ?
      `
    )
      .bind(id)
      .first();


  // 先刪資料庫紀錄（前台立即不再顯示），成功後才刪檔案；
  // 檔案刪除失敗只記錄，留下的檔案會在每日備份的孤兒檔案檢查中回報
  await env.DB.prepare(
    `
    DELETE FROM documents
    WHERE id = ?
    `
  )
    .bind(id)
    .run();

  if (doc?.file_key) {
    try {
      await env.FILES.delete(doc.file_key);
    } catch (error) {
      console.error("R2 delete failed (orphan left):", doc.file_key, error);
    }
  }


  return json({
    ok: true,
    message:
      "文件與檔案已刪除。"
  });
}


async function servePublicFile(
  path,
  env
) {

  const id =
    Number(
      path.slice(
        "/files/".length
      )
    );


  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  }


  const doc =
    await env.DB.prepare(
      `
      SELECT
        file_key,
        file_name,
        mime_type

      FROM documents

      WHERE
        id = ?
        AND is_public = 1
      `
    )
      .bind(id)
      .first();


  if (!doc?.file_key) {

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  }


  const object =
    await env.FILES.get(
      doc.file_key
    );


  if (!object) {

    return new Response(
      "Not found",
      {
        status: 404
      }
    );
  }


  const headers =
    new Headers();


  object.writeHttpMetadata(
    headers
  );


  headers.set(
    "etag",
    object.httpEtag
  );


  // 更換或隱藏文件後要很快生效，不做長時間快取
  headers.set(
    "Cache-Control",
    "public, max-age=300"
  );

  headers.set(
    "X-Content-Type-Options",
    "nosniff"
  );


  headers.set(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(
      doc.file_name ||
      "document"
    )}`
  );


  return new Response(
    object.body,
    {
      headers
    }
  );
}


function normalizeBoard(body) {

  return {

    member_type:
      clean(
        body.member_type,
        40
      ),

    name:
      clean(
        body.name,
        80
      ),

    title:
      clean(
        body.title,
        120
      ),

    representative:
      clean(
        body.representative,
        160
      ),

    note:
      clean(
        body.note,
        500
      ),

    sort_order:
      toInt(
        body.sort_order,
        0
      ),

    is_public:
      body.is_public === false ||
      Number(body.is_public) === 0
        ? 0
        : 1
  };
}


function clean(
  value,
  maxLength
) {

  return String(
    value ?? ""
  )
    .trim()
    .slice(
      0,
      maxLength
    );
}


function toInt(
  value,
  fallback = 0
) {

  const n =
    Number.parseInt(
      String(
        value ?? ""
      ),
      10
    );

  return Number.isFinite(n)
    ? n
    : fallback;
}


function slug(value) {

  return String(
    value || ""
  )
    .toLowerCase()
    .normalize("NFKD")
    .replace(
      /[^\p{L}\p{N}]+/gu,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(
      0,
      80
    );
}


// ===== 聯絡表單紀錄 =====
// fullhome-contact 寫入，這裡負責後台查詢、處理狀態、匯出與清理。資料表定義需與 workers/contact 相同。

const CONTACT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS contact_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    name TEXT, phone TEXT, city TEXT, address TEXT,
    age TEXT, owners TEXT, type TEXT, message TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    mail_status TEXT NOT NULL DEFAULT 'pending',
    mail_error TEXT,
    note TEXT,
    handled_by TEXT,
    handled_at TEXT
  )`;

const CONTACT_STATUSES = ["new", "contacted", "closed", "spam"];

let contactTableReady = false;

async function ensureContactTable(env) {
  if (contactTableReady) return;
  await env.DB.prepare(CONTACT_TABLE_SQL).run();
  contactTableReady = true;
}

function contactFilter(url) {
  const where = [];
  const binds = [];
  const status = url.searchParams.get("status") || "";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 50);

  if (CONTACT_STATUSES.includes(status)) {
    where.push("status = ?");
    binds.push(status);
  }

  if (q) {
    where.push("(name LIKE ? OR phone LIKE ? OR address LIKE ? OR message LIKE ? OR note LIKE ?)");
    const like = `%${q}%`;
    binds.push(like, like, like, like, like);
  }

  return { where, binds };
}

async function listContacts(url, env) {
  await ensureContactTable(env);
  const { where, binds } = contactFilter(url);
  const beforeId = Number(url.searchParams.get("before_id")) || 0;
  if (beforeId > 0) {
    where.push("id < ?");
    binds.push(beforeId);
  }

  const sql = `SELECT * FROM contact_submissions
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id DESC LIMIT 101`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];

  const counts = (await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM contact_submissions GROUP BY status"
  ).all()).results || [];

  const failed = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contact_submissions WHERE mail_status = 'failed'"
  ).first();

  return json({
    ok: true,
    items: rows.slice(0, 100),
    has_more: rows.length > 100,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.n])),
    mail_failed: failed ? failed.n : 0,
    retention_days: retentionDays(env)
  });
}

async function updateContact(request, env, me, id) {
  await ensureContactTable(env);
  const body = await request.json();
  const status = CONTACT_STATUSES.includes(body.status) ? body.status : null;
  if (!status) return json({ ok: false, message: "狀態不正確。" }, 400);

  const result = await env.DB.prepare(`
    UPDATE contact_submissions
    SET status = ?, note = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(status, clean(body.note, 1000), me.email, id).run();

  if (!result.meta?.changes) return json({ ok: false, message: "找不到此筆資料。" }, 404);
  return json({ ok: true, message: "已更新。" });
}

async function deleteContact(env, me, id) {
  await ensureContactTable(env);
  await env.DB.prepare("DELETE FROM contact_submissions WHERE id = ?").bind(id).run();
  console.log("contact deleted", id, me.email);
  return json({ ok: true, message: "已刪除。" });
}

function csvCell(v, asText) {
  let s = String(v ?? "");
  // 防 CSV 公式注入（Excel 會把 = + - @ 開頭當公式）
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  // 電話等數字欄位保留開頭的 0
  if (asText && /^\d/.test(s)) s = "\t" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

const CONTACT_STATUS_LABELS = { new: "新進件", contacted: "已聯絡", closed: "已結案", spam: "垃圾訊息" };

async function exportContactsCsv(url, env, me) {
  await ensureContactTable(env);
  const { where, binds } = contactFilter(url);
  const sql = `SELECT * FROM contact_submissions
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY id DESC LIMIT 5000`;
  const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];

  const header = ["編號", "送出時間", "姓名", "電話", "縣市", "基地地址", "屋齡", "地主/住戶概況", "希望了解", "其他說明", "處理狀態", "備註", "處理人", "處理時間", "通知信"];
  const lines = [header.map((h) => csvCell(h)).join(",")];

  for (const r of rows) {
    lines.push([
      r.id, taipeiTime(r.created_at), r.name, r.phone, r.city, r.address,
      r.age, r.owners, r.type, r.message, CONTACT_STATUS_LABELS[r.status] || r.status,
      r.note, r.handled_by, taipeiTime(r.handled_at), r.mail_status === "sent" ? "已寄出" : r.mail_status === "failed" ? "寄送失敗" : "處理中"
    ].map((v, i) => csvCell(v, i === 3)).join(","));
  }

  console.log("contacts exported", rows.length, me.email);

  const date = taipeiTime(new Date()).slice(0, 10);
  return new Response("\uFEFF" + lines.join("\r\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contact-submissions-${date}.csv"`,
      "Cache-Control": "no-store"
    }
  });
}

// 資料庫內一律存 UTC（D1 的 CURRENT_TIMESTAMP 是 UTC，保存期限比對也依賴它）；
// 所有給人看的輸出（後台、CSV、備份檔名）轉成台灣時間 GMT+8。
function taipeiTime(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(String(v).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(v)) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function retentionDays(env) {
  const n = Number(env.CONTACT_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 365;
}


// ===== 系統備份（每日排程 + 後台手動）=====
// D1：每張表匯出成 JSON 快照，保留最近 30 份。
// R2：fullhome-files 的檔案增量複製到備份 bucket 的 files/，來源刪除時備份不刪（防誤刪）。

const BACKUP_KEEP = 30;
const FILE_COPY_LIMIT = 200;

async function runMaintenance(env, by) {
  const result = { at: new Date().toISOString(), by, purged_contacts: 0, d1: null, files: null, errors: [] };

  try {
    await ensureContactTable(env);
    const r = await env.DB.prepare(
      "DELETE FROM contact_submissions WHERE created_at < datetime('now', ?)"
    ).bind(`-${retentionDays(env)} days`).run();
    result.purged_contacts = r.meta?.changes || 0;
  } catch (e) {
    result.errors.push("purge: " + e.message);
  }

  try {
    await ensureAuditTable(env);
    const r = await env.DB.prepare("DELETE FROM audit_logs WHERE at < datetime('now', '-730 days')").run();
    result.purged_audit = r.meta?.changes || 0;
  } catch (e) {
    result.errors.push("audit purge: " + e.message);
  }

  try {
    result.orphans = await findOrphanFiles(env);
  } catch (e) {
    result.errors.push("orphans: " + e.message);
  }

  if (!env.BACKUPS) {
    result.errors.push("BACKUPS bucket not bound");
  } else {
    try { result.d1 = await backupD1(env); } catch (e) { result.errors.push("d1: " + e.message); }
    try { result.files = await backupFiles(env); } catch (e) { result.errors.push("files: " + e.message); }
  }

  // 健康檢查放在備份之後，備份失敗也會被列為異常
  try {
    result.health = await runHealthChecks(env, result);
  } catch (e) {
    result.health = { issues: ["健康檢查本身執行失敗：" + e.message], checks: {} };
  }

  if (by === "cron" && result.health.issues.length) {
    result.health.alert = await sendAlert(env, result.health);
  }

  if (env.BACKUPS) {
    await env.BACKUPS.put("status/last-run.json", JSON.stringify(result, null, 2), {
      httpMetadata: { contentType: "application/json" }
    });
  }

  console.log("maintenance", JSON.stringify(result));
  return result;
}

// ===== 稽核紀錄 =====

let auditTableReady = false;

async function ensureAuditTable(env) {
  if (auditTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT DEFAULT CURRENT_TIMESTAMP,
      email TEXT, method TEXT, path TEXT, status INTEGER, summary TEXT
    )
  `).run();
  auditTableReady = true;
}

// 記錄內容摘要：JSON 取前 500 字；上傳只記檔名，不存檔案內容
async function auditSummary(request) {
  try {
    const ct = request.headers.get("content-type") || "";
    const c = request.clone();
    if (ct.includes("multipart/form-data")) {
      const form = await c.formData();
      const f = form.get("file");
      const title = form.get("title");
      return JSON.stringify({ file: f && f.name, size: f && f.size, title: title || undefined });
    }
    if (ct.includes("json")) return (await c.text()).slice(0, 500);
  } catch (e) {
    return "";
  }
  return "";
}

async function writeAudit(env, email, method, path, status, summary) {
  try {
    await ensureAuditTable(env);
    await env.DB.prepare(
      "INSERT INTO audit_logs (email, method, path, status, summary) VALUES (?, ?, ?, ?, ?)"
    ).bind(email, method, path, status, summary).run();
  } catch (e) {
    console.error("audit write failed:", e);
  }
}

async function listAudit(url, env) {
  await ensureAuditTable(env);
  const before = Number(url.searchParams.get("before_id")) || 0;
  const rows = (await env.DB.prepare(
    `SELECT * FROM audit_logs ${before ? "WHERE id < ?" : ""} ORDER BY id DESC LIMIT 101`
  ).bind(...(before ? [before] : [])).all()).results || [];
  return json({ ok: true, items: rows.slice(0, 100), has_more: rows.length > 100 });
}

// ===== 每日健康檢查 =====
// 有異常才寄信（ALERT_TO，經由 fullhome-contact 寄出），沒事不打擾。

async function runHealthChecks(env, maintenance) {
  const issues = [];
  const checks = {};

  // 1. 官網首頁（同網域子請求會直接到 Pages 原站）
  try {
    const r = await fetch(SITE_ORIGIN + "/", { headers: { "User-Agent": "fullhome-healthcheck" } });
    const t = await r.text();
    checks.homepage = r.status;
    if (r.status !== 200 || !t.includes("data-edit=")) issues.push(`官網首頁異常（HTTP ${r.status}）`);
  } catch (e) {
    checks.homepage = "error";
    issues.push("官網首頁無法連線：" + e.message);
  }

  // 2. 投資人資料
  try {
    const c = await env.DB.prepare("SELECT company_name FROM company_profile WHERE id = 1").first();
    checks.investors = c && c.company_name ? "ok" : "missing";
    if (!c || !c.company_name) issues.push("公司基本資料不存在或為空白，投資人專區會顯示不完整");
  } catch (e) {
    checks.investors = "error";
    issues.push("資料庫查詢失敗：" + e.message);
  }

  // 3. 聯絡表單 Worker 是否存活
  if (env.CONTACT) {
    try {
      const r = await env.CONTACT.fetch("http://internal/ping");
      checks.contact_worker = r.status;
      if (!r.ok) issues.push(`聯絡表單服務異常（HTTP ${r.status}）`);
    } catch (e) {
      checks.contact_worker = "error";
      issues.push("聯絡表單服務無法連線：" + e.message);
    }
  }

  // 4. 過去 24 小時通知信寄送失敗、或卡在處理中超過 1 小時
  try {
    await ensureContactTable(env);
    const f = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contact_submissions WHERE mail_status = 'failed' AND created_at >= datetime('now', '-1 day')"
    ).first();
    const p = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contact_submissions WHERE mail_status = 'pending' AND created_at < datetime('now', '-1 hour')"
    ).first();
    checks.mail_failed_24h = f.n;
    checks.mail_pending = p.n;
    if (f.n) issues.push(`過去 24 小時有 ${f.n} 筆聯絡表單的通知信寄送失敗（資料已保存，請到後台「聯絡表單」查看並回電）`);
    if (p.n) issues.push(`有 ${p.n} 筆聯絡表單的通知信未完成寄送（資料已保存，請到後台查看）`);
  } catch (e) {
    issues.push("聯絡表單紀錄查詢失敗：" + e.message);
  }

  // 5. 備份
  if (maintenance.errors.length) issues.push("備份或清理有錯誤：" + maintenance.errors.join("；"));

  // 6. 孤兒文件檔案
  if (maintenance.orphans && maintenance.orphans.documents) {
    issues.push(`R2 有 ${maintenance.orphans.documents} 個文件檔案沒有對應的文件紀錄（例：${maintenance.orphans.sample.slice(0, 3).join("、")}）`);
  }

  // 7. Entra 密鑰到期（ENTRA_SECRET_EXPIRES = YYYY-MM-DD）
  const exp = String(env.ENTRA_SECRET_EXPIRES || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) {
    const days = Math.floor((Date.parse(exp + "T00:00:00+08:00") - Date.now()) / 86400000);
    checks.entra_secret_days_left = days;
    if (days <= 30) {
      issues.push(days < 0
        ? `聯絡表單寄信用的 Entra Client Secret 已於 ${exp} 到期，通知信無法寄出（表單資料仍會保存）`
        : `聯絡表單寄信用的 Entra Client Secret 將於 ${exp} 到期（剩 ${days} 天），請盡快更新`);
    }
  } else {
    checks.entra_secret_days_left = "未設定 ENTRA_SECRET_EXPIRES";
  }

  return { issues, checks };
}

async function sendAlert(env, health) {
  if (!env.CONTACT) return "CONTACT service binding 未設定";

  const date = taipeiTime(new Date());
  const items = health.issues.map((i) => `<li style="margin:6px 0">${escHtml(i)}</li>`).join("");
  const html = `
    <div style="font-family:'Microsoft JhengHei',Arial,sans-serif;color:#171827">
      <h2 style="color:#0D045F;margin:0 0 8px">馥鴻官網每日檢查發現 ${health.issues.length} 項異常</h2>
      <p style="color:#6c7282;margin:0 0 12px">檢查時間：${escHtml(date)}（台灣時間）</p>
      <ul style="padding-left:20px">${items}</ul>
      <p style="margin-top:16px"><a href="${SITE_ORIGIN}/admin/">開啟網站管理後台</a>（「系統備份」可查看完整檢查結果）</p>
    </div>`;

  try {
    const r = await env.CONTACT.fetch("http://internal/alert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: `【馥鴻官網】每日檢查異常 ${health.issues.length} 項`, html })
    });
    return r.ok ? "sent" : `failed ${r.status}`;
  } catch (e) {
    return "failed: " + e.message;
  }
}

function escHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

// R2 裡沒有被任何資料引用的檔案（只回報，不自動刪除）
async function findOrphanFiles(env) {
  const docKeys = new Set(
    ((await env.DB.prepare("SELECT file_key FROM documents WHERE file_key IS NOT NULL").all()).results || [])
      .map((r) => r.file_key)
  );

  await ensureSiteContentTable(env);
  const mediaKeys = new Set(
    ((await env.DB.prepare("SELECT value FROM site_content WHERE type = 'image'").all()).results || [])
      .map((r) => String(r.value).replace(/^\//, ""))
  );

  const orphans = [];
  let cursor;
  do {
    const page = await env.FILES.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      // media/ 是頁面圖片：上傳後尚未儲存或已被替換的舊圖，屬正常情況，只計數
      const used = o.key.startsWith("media/") ? mediaKeys.has(o.key) : docKeys.has(o.key);
      if (!used) orphans.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const documents = orphans.filter((k) => !k.startsWith("media/"));
  return { documents: documents.length, media: orphans.length - documents.length, sample: documents.slice(0, 10) };
}

async function backupD1(env) {
  const tables = (await env.DB.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
  ).all()).results || [];

  const now = new Date();
  const snapshot = {
    database: "fullhome-cms-db",
    created_at: now.toISOString(),
    created_at_taipei: taipeiTime(now) + " (GMT+8)",
    note: "資料表內的時間欄位為 UTC",
    tables: {}
  };
  let rowCount = 0;

  for (const t of tables) {
    const rows = (await env.DB.prepare(`SELECT * FROM "${t.name.replace(/"/g, '""')}"`).all()).results || [];
    snapshot.tables[t.name] = { schema: t.sql, rows };
    rowCount += rows.length;
  }

  // 檔名用台灣時間，例：20261015-020000-123（含毫秒，避免同一秒內重複執行時互相覆蓋）
  const stamp = taipeiTime(now).replace(/[-:]/g, "").replace(" ", "-") + "-" + String(now.getMilliseconds()).padStart(3, "0");
  const key = `d1/fullhome-cms-db-${stamp}.json`;
  await env.BACKUPS.put(key, JSON.stringify(snapshot), { httpMetadata: { contentType: "application/json" } });

  // 只保留最近 BACKUP_KEEP 份
  const listed = await env.BACKUPS.list({ prefix: "d1/" });
  const old = listed.objects.map((o) => o.key).sort().reverse().slice(BACKUP_KEEP);
  if (old.length) await env.BACKUPS.delete(old);

  return { key, tables: tables.length, rows: rowCount, removed_old: old.length };
}

async function backupFiles(env) {
  let cursor;
  let copied = 0, skipped = 0, total = 0;

  do {
    const page = await env.FILES.list({ cursor, limit: 500 });
    for (const obj of page.objects) {
      total++;
      const dest = `files/${obj.key}`;
      const existing = await env.BACKUPS.head(dest);
      if (existing && existing.customMetadata?.sourceEtag === obj.etag) {
        skipped++;
        continue;
      }
      if (copied >= FILE_COPY_LIMIT) continue;

      const src = await env.FILES.get(obj.key);
      if (!src) continue;
      await env.BACKUPS.put(dest, await src.arrayBuffer(), {
        httpMetadata: src.httpMetadata,
        customMetadata: { ...(src.customMetadata || {}), sourceEtag: obj.etag }
      });
      copied++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return { total, copied, skipped, pending: Math.max(0, total - copied - skipped) };
}

async function listBackups(env) {
  if (!env.BACKUPS) return json({ ok: false, message: "尚未設定備份空間（BACKUPS）。" }, 500);

  const d1 = await env.BACKUPS.list({ prefix: "d1/" });
  let fileCount = 0, fileBytes = 0, cursor;
  do {
    const page = await env.BACKUPS.list({ prefix: "files/", cursor, limit: 1000 });
    fileCount += page.objects.length;
    fileBytes += page.objects.reduce((n, o) => n + o.size, 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const last = await env.BACKUPS.get("status/last-run.json");

  return json({
    ok: true,
    snapshots: d1.objects
      .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
      .sort((a, b) => (a.key < b.key ? 1 : -1)),
    files: { count: fileCount, bytes: fileBytes },
    last_run: last ? await last.json() : null
  });
}

async function downloadBackup(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!/^d1\/fullhome-cms-db-[0-9-]+\.json$/.test(key)) return json({ ok: false, message: "檔名不正確。" }, 400);
  const obj = await env.BACKUPS.get(key);
  if (!obj) return json({ ok: false, message: "找不到備份。" }, 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${key.slice(3)}"`,
      "Cache-Control": "no-store"
    }
  });
}


// ===== 頁面內容（首頁每個區塊的文字與圖片）=====
// HTML 裡用 data-edit / data-edit-img / data-edit-bg 標記可編輯區塊；
// 這裡只存「有改過的」值，沒改過的維持 HTML 原本內容。

let siteContentTableReady = false;

async function ensureSiteContentTable(env) {
  if (siteContentTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_content_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id TEXT NOT NULL,
      source TEXT,
      key TEXT NOT NULL,
      old_type TEXT, old_value TEXT,
      new_type TEXT, new_value TEXT,
      changed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      changed_by TEXT
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )
  `).run();
  siteContentTableReady = true;
}

async function loadSiteContent(env) {
  await ensureSiteContentTable(env);
  const result = await env.DB.prepare("SELECT key, type, value FROM site_content").all();
  return new Map((result.results || []).map((r) => [r.key, r]));
}

const CONTENT_KEY_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

// SEO 與分享預覽欄位的長度上限
const SEO_MAX = {
  "seo.title": 80,
  "seo.description": 300,
  "seo.og-title": 80,
  "seo.og-description": 300
};

const SITE_ORIGIN = "https://www.full-home.com.tw";
const MEDIA_URL_RE = /^\/media\/[a-z0-9-]+\.(?:png|jpe?g|webp)$/;

// 只允許少數行內標籤，且不保留任何屬性
function sanitizeInlineHtml(html) {
  return String(html ?? "")
    .slice(0, 5000)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(\/?)([a-zA-Z0-9]+)[^>]*>/g, (m, close, tag) => {
      tag = tag.toLowerCase();
      if (tag === "br") return close ? "" : "<br>";
      if (["span", "strong", "b", "em", "small"].includes(tag)) return `<${close}${tag}>`;
      return "";
    })
    .replace(/<(?!\/?(?:br|span|strong|b|em|small)>)/g, "&lt;")
    .replace(/&nbsp;/g, " ")
    .trim();
}

async function saveSiteContent(request, env, me) {
  const body = await request.json();
  const changes = body && typeof body.changes === "object" ? body.changes : {};
  return applyContentChanges(env, me, changes, "edit");
}

// 套用頁面內容修改，並把「修改前 / 修改後」記錄到 site_content_history（同一批次一個 batch_id）
// 檢查並整理一項內容修改；回傳 { error } 或 { value: null | { type, value } }
function resolveContentChange(key, c) {
    if (!CONTENT_KEY_RE.test(key) || key.length > 80) {
      return { error: `欄位代碼不正確：${key}` };
    }

    
    if (c === null) {
      return { value: null };
    }
    if (!c || typeof c !== "object") return { error: "內容類型不正確。" };

    if (c.type === "text") {
      const value = sanitizeInlineHtml(c.value);
      if (!value) return { error: `「${key}」不可空白；要恢復原文請用「還原預設」。` };
      return { value: { type: "text", value } };
    } else if (c.type === "plain") {
      // SEO 標題/描述：純文字，不允許任何 HTML
      const value = String(c.value ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, SEO_MAX[key] || 300);
      if (!value) return { error: `「${key}」不可空白；要恢復預設請用「還原預設」。` };
      return { value: { type: "plain", value } };
    } else if (c.type === "image") {
      const value = String(c.value || "");
      if (!MEDIA_URL_RE.test(value)) return { error: "圖片網址不正確。" };
      return { value: { type: "image", value } };
    } else if (c.type === "layout") {
      if (!key.startsWith("layout.")) return { error: `欄位代碼不正確：${key}` };
      const norm = normalizeLayout(parseJsonValue(c.value), key.slice(7));
      if (!norm) return { error: "區塊排列資料不正確。" };
      return { value: { type: "layout", value: JSON.stringify(norm) } };
    } else if (c.type === "tstyle") {
      if (!key.startsWith("style.")) return { error: `欄位代碼不正確：${key}` };
      const norm = normalizeTextStyle(parseJsonValue(c.value));
      return { value: norm ? { type: "tstyle", value: JSON.stringify(norm) } : null };
    } else if (c.type === "bstyle") {
      if (!key.startsWith("bstyle.")) return { error: `欄位代碼不正確：${key}` };
      const norm = normalizeBoxStyle(parseJsonValue(c.value));
      return { value: norm ? { type: "bstyle", value: JSON.stringify(norm) } : null };
    } else {
      return { error: "內容類型不正確。" };
    }
  
  return { error: "內容類型不正確。" };
}

async function applyContentChanges(env, me, changes, source, note) {
  // 先確保版本表存在：第一次使用時的「啟用版本控制時的正式內容」還原點要在修改「之前」建立
  await ensureVersionTables(env);
  const keys = Object.keys(changes);

  if (!keys.length) return json({ ok: false, message: "沒有需要儲存的修改。" }, 400);
  if (keys.length > 400) return json({ ok: false, message: "一次修改太多項目。" }, 400);

  // 先把每一項整理成要寫入的值（null = 刪除，恢復網站原始內容 / 樣式）
  const resolved = new Map();
  for (const key of keys) {
    const r = resolveContentChange(key, changes[key]);
    if (r.error) return json({ ok: false, message: r.error }, 400);
    resolved.set(key, r.value);
  }

  // 修改前的值
  const placeholders = keys.map(() => "?").join(",");
  const before = new Map(
    ((await env.DB.prepare(`SELECT key, type, value FROM site_content WHERE key IN (${placeholders})`)
      .bind(...keys).all()).results || []).map((r) => [r.key, r])
  );

  const stmts = [];
  const batchId = crypto.randomUUID();
  let changed = 0;

  for (const key of keys) {
    const next = resolved.get(key);
    const oldRow = before.get(key) || null;

    // 沒有實際變化的不寫入、不記錄
    if ((oldRow ? oldRow.value : null) === (next ? next.value : null)) continue;
    changed++;

    if (next === null) {
      stmts.push(env.DB.prepare("DELETE FROM site_content WHERE key = ?").bind(key));
    } else {
      stmts.push(env.DB.prepare(`
        INSERT INTO site_content (key, type, value, updated_at, updated_by)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
        ON CONFLICT(key) DO UPDATE SET
          type = excluded.type, value = excluded.value,
          updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
      `).bind(key, next.type, next.value, me.email));
    }

    stmts.push(env.DB.prepare(`
      INSERT INTO site_content_history (batch_id, source, key, old_type, old_value, new_type, new_value, changed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(batchId, source, key, oldRow ? oldRow.type : null, oldRow ? oldRow.value : null,
      next ? next.type : null, next ? next.value : null, me.email));
  }

  if (stmts.length) await env.DB.batch(stmts);
  console.log("site content saved", me.email, source, keys.length, "changed", changed);

  // 正式內容有變動就存一個完整版本，之後可以預覽或還原
  if (changed) {
    try {
      await createVersion(env, me, source, note || VERSION_SOURCE_NOTE[source] || "");
    } catch (error) {
      console.error("create version failed:", error);
    }
  }
  return json({ ok: true, batch_id: batchId, message: changed ? `已儲存 ${changed} 處修改。` : "內容與目前相同，沒有變更。" });
}

// ===== 草稿、預覽、版本、還原點 =====
// 編輯器存的是「草稿」（site_content_draft），只有後台看得到；按「發布上線」才寫進正式內容。
// 每次正式內容有變動（發布、還原、修改紀錄還原）都會存一個完整版本（site_versions），可以預覽、還原。
// 還原點（is_baseline=1）不會被自動清除，只有系統管理員（SUPER_ADMINS）可以還原。

const VERSION_KEEP = 50;

let versionTablesReady = false;

async function ensureVersionTables(env) {
  if (versionTablesReady) return;
  await ensureSiteContentTable(env);
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_content_draft (
      key TEXT PRIMARY KEY,
      type TEXT,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )
  `).run();
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      source TEXT,
      note TEXT,
      item_count INTEGER,
      data TEXT NOT NULL,
      is_baseline INTEGER DEFAULT 0
    )
  `).run();
  versionTablesReady = true;

  // 第一次啟用：建立兩個還原點——網站原始設計（沒有任何後台修改），以及啟用當下的正式內容
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_versions").first();
  if (!n.n) {
    const live = await liveRows(env);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO site_versions (created_by, source, note, item_count, data, is_baseline) VALUES (?, 'baseline', ?, 0, '[]', 1)"
      ).bind("system", "網站原始設計（沒有任何後台修改）"),
      env.DB.prepare(
        "INSERT INTO site_versions (created_by, source, note, item_count, data, is_baseline) VALUES (?, 'baseline', ?, ?, ?, 1)"
      ).bind("system", "啟用版本控制時的正式內容", live.length, JSON.stringify(live))
    ]);
  }
}

async function liveRows(env) {
  return (await env.DB.prepare("SELECT key, type, value FROM site_content ORDER BY key").all()).results || [];
}

async function loadDraft(env) {
  await ensureVersionTables(env);
  const rows = (await env.DB.prepare("SELECT key, type, value, updated_at, updated_by FROM site_content_draft ORDER BY key").all()).results || [];
  return rows;
}

// 正式內容 + 草稿（草稿 type 為 NULL 代表發布時要刪除，恢復網站原始內容）
function mergeDraft(live, draftRows) {
  const merged = new Map(live);
  for (const d of draftRows) {
    if (d.type === null) merged.delete(d.key);
    else merged.set(d.key, { key: d.key, type: d.type, value: d.value });
  }
  return merged;
}

async function createVersion(env, me, source, note) {
  await ensureVersionTables(env);
  const live = await liveRows(env);
  await env.DB.prepare(
    "INSERT INTO site_versions (created_by, source, note, item_count, data) VALUES (?, ?, ?, ?, ?)"
  ).bind(me.email, source, note || "", live.length, JSON.stringify(live)).run();

  // 只保留最近 VERSION_KEEP 個一般版本；還原點不刪
  await env.DB.prepare(`
    DELETE FROM site_versions
    WHERE is_baseline = 0 AND id NOT IN (
      SELECT id FROM site_versions WHERE is_baseline = 0 ORDER BY id DESC LIMIT ?
    )
  `).bind(VERSION_KEEP).run();
}

async function getDraft(env) {
  const rows = await loadDraft(env);
  return json({ ok: true, items: rows, count: rows.length });
}

async function saveDraft(request, env, me) {
  await ensureVersionTables(env);
  const body = await request.json();
  const changes = body && typeof body.changes === "object" ? body.changes : {};
  const keys = Object.keys(changes);
  if (!keys.length) return json({ ok: false, message: "沒有需要儲存的修改。" }, 400);
  if (keys.length > 400) return json({ ok: false, message: "一次修改太多項目。" }, 400);

  const resolved = new Map();
  for (const key of keys) {
    const r = resolveContentChange(key, changes[key]);
    if (r.error) return json({ ok: false, message: r.error }, 400);
    resolved.set(key, r.value);
  }

  const placeholders = keys.map(() => "?").join(",");
  const live = new Map(
    ((await env.DB.prepare(`SELECT key, type, value FROM site_content WHERE key IN (${placeholders})`)
      .bind(...keys).all()).results || []).map((r) => [r.key, r])
  );

  const stmts = [];
  for (const key of keys) {
    const next = resolved.get(key);
    const cur = live.get(key);
    // 和正式內容一樣 → 草稿不需要這一項
    if ((cur ? cur.value : null) === (next ? next.value : null)) {
      stmts.push(env.DB.prepare("DELETE FROM site_content_draft WHERE key = ?").bind(key));
      continue;
    }
    stmts.push(env.DB.prepare(`
      INSERT INTO site_content_draft (key, type, value, updated_at, updated_by)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(key) DO UPDATE SET
        type = excluded.type, value = excluded.value,
        updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
    `).bind(key, next ? next.type : null, next ? next.value : null, me.email));
  }
  await env.DB.batch(stmts);

  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM site_content_draft").first();
  return json({ ok: true, count: n.n, message: `草稿已儲存（目前共 ${n.n} 處尚未發布）。` });
}

async function discardDraft(env) {
  await ensureVersionTables(env);
  await env.DB.prepare("DELETE FROM site_content_draft").run();
  return json({ ok: true, message: "草稿已捨棄。" });
}

async function publishDraft(request, env, me) {
  await ensureVersionTables(env);
  const body = await request.json().catch(() => ({}));
  const note = String(body.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const rows = await loadDraft(env);
  if (!rows.length) return json({ ok: false, message: "目前沒有草稿可以發布。" }, 400);

  const changes = {};
  for (const r of rows) changes[r.key] = r.type === null ? null : { type: r.type, value: r.value };

  const res = await applyContentChanges(env, me, changes, "publish", note || "發布草稿");
  if (res.status !== 200) return res;

  // 只清掉剛發布的那些草稿（發布期間別人又存的新草稿保留）
  const stmts = rows.map((r) =>
    env.DB.prepare("DELETE FROM site_content_draft WHERE key = ? AND updated_at = ?").bind(r.key, r.updated_at)
  );
  await env.DB.batch(stmts);

  return json({ ok: true, message: `已發布上線（${rows.length} 處）。` });
}

async function listVersions(env) {
  await ensureVersionTables(env);
  const rows = (await env.DB.prepare(`
    SELECT id, created_at, created_by, source, note, item_count, is_baseline
    FROM site_versions ORDER BY is_baseline DESC, id DESC LIMIT 120
  `).all()).results || [];
  const current = (await env.DB.prepare("SELECT id FROM site_versions WHERE is_baseline = 0 ORDER BY id DESC LIMIT 1").first());
  return json({ ok: true, items: rows, current_id: current ? current.id : null });
}

async function restoreVersion(env, me, id) {
  await ensureVersionTables(env);
  const v = await env.DB.prepare("SELECT * FROM site_versions WHERE id = ?").bind(id).first();
  if (!v) return json({ ok: false, message: "找不到這個版本。" }, 404);
  if (v.is_baseline && !me.is_super) {
    return json({ ok: false, message: "還原點只有系統管理員可以還原。" }, 403);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(v.data);
  } catch {
    return json({ ok: false, message: "版本資料損壞，無法還原。" }, 500);
  }

  const target = new Map(snapshot.map((r) => [r.key, r]));
  const live = await liveRows(env);
  const changes = {};
  for (const r of live) if (!target.has(r.key)) changes[r.key] = null;
  for (const r of snapshot) {
    const cur = live.find((x) => x.key === r.key);
    if (!cur || cur.value !== r.value || cur.type !== r.type) changes[r.key] = { type: r.type, value: r.value };
  }

  if (!Object.keys(changes).length) return json({ ok: true, message: "目前的正式內容已經和這個版本相同。" });

  const label = v.is_baseline ? "還原點" : "版本";
  const res = await applyContentChanges(env, me, changes, "restore", `還原到${label} #${v.id}${v.note ? "（" + v.note + "）" : ""}`, true);
  if (res.status !== 200) return res;
  return json({ ok: true, message: `已還原到${label} #${v.id} 並上線。` });
}

async function setBaseline(request, env, me, id) {
  if (!me.is_super) return json({ ok: false, message: "只有系統管理員可以設定還原點。" }, 403);
  await ensureVersionTables(env);
  const body = await request.json().catch(() => ({}));
  const on = body.on !== false;
  const v = await env.DB.prepare("SELECT id, source FROM site_versions WHERE id = ?").bind(id).first();
  if (!v) return json({ ok: false, message: "找不到這個版本。" }, 404);
  if (!on && v.source === "baseline") return json({ ok: false, message: "系統建立的還原點不能取消。" }, 400);
  const note = body.note !== undefined ? String(body.note).trim().slice(0, 200) : null;
  if (note !== null) {
    await env.DB.prepare("UPDATE site_versions SET is_baseline = ?, note = ? WHERE id = ?").bind(on ? 1 : 0, note, id).run();
  } else {
    await env.DB.prepare("UPDATE site_versions SET is_baseline = ? WHERE id = ?").bind(on ? 1 : 0, id).run();
  }
  return json({ ok: true, message: on ? "已設為還原點。" : "已取消還原點。" });
}

async function versionContent(env, id) {
  await ensureVersionTables(env);
  const v = await env.DB.prepare("SELECT data FROM site_versions WHERE id = ?").bind(id).first();
  if (!v) return null;
  try {
    return new Map(JSON.parse(v.data).map((r) => [r.key, r]));
  } catch {
    return null;
  }
}

const VERSION_SOURCE_NOTE = { edit: "直接儲存", publish: "發布草稿", revert: "從修改紀錄還原", restore: "還原版本" };

// ===== 頁面編輯鎖：同一時間只有一個人可以編輯頁面內容 =====
// 編輯器每分鐘回報一次（心跳）；超過 LOCK_TTL_MIN 分鐘沒有心跳就自動釋放。
// 系統管理員可以強制接手（例如有人開著分頁就離開）。

const LOCK_TTL_MIN = 3;
let lockTableReady = false;

async function ensureLockTable(env) {
  if (lockTableReady) return;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS page_edit_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email TEXT,
      name TEXT,
      acquired_at TEXT,
      heartbeat_at TEXT
    )
  `).run();
  await env.DB.prepare("INSERT OR IGNORE INTO page_edit_lock (id) VALUES (1)").run();
  lockTableReady = true;
}

async function readLock(env) {
  await ensureLockTable(env);
  const r = await env.DB.prepare(`
    SELECT email, name, acquired_at, heartbeat_at,
      (email IS NOT NULL AND heartbeat_at >= datetime('now', ?)) AS active
    FROM page_edit_lock WHERE id = 1
  `).bind(`-${LOCK_TTL_MIN} minutes`).first();
  return r && r.active ? { email: r.email, name: r.name, acquired_at: r.acquired_at, heartbeat_at: r.heartbeat_at } : null;
}

// 取得或續約編輯鎖；成功回傳 true
async function tryAcquireLock(env, me, force) {
  await ensureLockTable(env);
  const res = await env.DB.prepare(`
    UPDATE page_edit_lock SET
      acquired_at = CASE WHEN email = ? AND heartbeat_at >= datetime('now', ?) THEN acquired_at ELSE CURRENT_TIMESTAMP END,
      email = ?, name = ?, heartbeat_at = CURRENT_TIMESTAMP
    WHERE id = 1 AND (? = 1 OR email IS NULL OR email = ? OR heartbeat_at < datetime('now', ?))
  `).bind(me.email, `-${LOCK_TTL_MIN} minutes`, me.email, me.name || "", force ? 1 : 0, me.email, `-${LOCK_TTL_MIN} minutes`).run();
  return (res.meta?.changes || 0) === 1;
}

function lockBusyResponse(holder) {
  return json({
    ok: false,
    locked: true,
    holder,
    message: `${holder.name || holder.email} 正在編輯頁面內容，同一時間只能一個人編輯。請等對方完成，或請系統管理員接手。`
  }, 423);
}

// 寫入頁面內容前呼叫：別人正在編輯就擋下；否則順便取得 / 續約編輯鎖
async function requireEditLock(env, me) {
  if (await tryAcquireLock(env, me, false)) return null;
  return lockBusyResponse(await readLock(env));
}

async function getLock(env, me) {
  const holder = await readLock(env);
  return json({ ok: true, holder, mine: !!holder && holder.email === me.email, ttl_min: LOCK_TTL_MIN });
}

async function acquireLock(request, env, me) {
  const body = await request.json().catch(() => ({}));
  const force = body.force === true;
  if (force && !me.is_super) return json({ ok: false, message: "只有系統管理員可以強制接手。" }, 403);
  const before = force ? await readLock(env) : null;
  if (!(await tryAcquireLock(env, me, force))) return lockBusyResponse(await readLock(env));
  if (force && before && before.email !== me.email) console.log("edit lock taken over", me.email, "from", before.email);
  return json({ ok: true, holder: await readLock(env), mine: true, ttl_min: LOCK_TTL_MIN });
}

async function releaseLock(env, me) {
  await ensureLockTable(env);
  await env.DB.prepare("UPDATE page_edit_lock SET email = NULL, name = NULL WHERE id = 1 AND email = ?").bind(me.email).run();
  return json({ ok: true });
}

// 修改紀錄：依批次分組，最近的在前
async function listContentHistory(url, env) {
  await ensureSiteContentTable(env);
  const rows = (await env.DB.prepare(`
    SELECT * FROM site_content_history
    WHERE batch_id IN (
      SELECT batch_id FROM site_content_history
      GROUP BY batch_id ORDER BY MAX(id) DESC LIMIT 40
    )
    ORDER BY id DESC
  `).all()).results || [];

  const batches = [];
  const byId = new Map();
  for (const r of rows) {
    let b = byId.get(r.batch_id);
    if (!b) {
      b = { batch_id: r.batch_id, changed_at: r.changed_at, changed_by: r.changed_by, source: r.source, items: [] };
      byId.set(r.batch_id, b);
      batches.push(b);
    }
    b.items.push({ id: r.id, key: r.key, old_type: r.old_type, old_value: r.old_value, new_type: r.new_type, new_value: r.new_value });
  }

  return json({ ok: true, batches });
}

// 還原：把指定批次（或其中一項）改回修改前的值；還原本身也會產生一筆新的紀錄
async function revertContentHistory(request, env, me) {
  await ensureSiteContentTable(env);
  const body = await request.json();
  const batchId = String(body.batch_id || "");
  const itemId = Number(body.item_id) || 0;

  const rows = (await env.DB.prepare(
    itemId
      ? "SELECT * FROM site_content_history WHERE batch_id = ? AND id = ?"
      : "SELECT * FROM site_content_history WHERE batch_id = ? ORDER BY id"
  ).bind(...(itemId ? [batchId, itemId] : [batchId])).all()).results || [];

  if (!rows.length) return json({ ok: false, message: "找不到這筆修改紀錄。" }, 404);

  const changes = {};
  for (const r of rows) {
    changes[r.key] = r.old_value === null ? null : { type: r.old_type, value: r.old_value };
  }

  return applyContentChanges(env, me, changes, "revert");
}

const IMAGE_SIGNATURES = {
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
               b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
};

async function uploadSiteImage(request, env) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) return json({ ok: false, message: "請選擇圖片。" }, 400);
  if (file.size > 5 * 1024 * 1024) return json({ ok: false, message: "圖片上限為 5 MB。" }, 400);

  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = Object.keys(IMAGE_SIGNATURES).find((k) => IMAGE_SIGNATURES[k](buf));
  if (!ext) return json({ ok: false, message: "只接受 JPG、PNG、WebP 圖片。" }, 400);

  const name = `${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const contentType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;

  await env.FILES.put(`media/${name}`, buf, { httpMetadata: { contentType } });

  return json({ ok: true, url: `/media/${name}` });
}

async function serveMedia(path, env) {
  if (!MEDIA_URL_RE.test(path)) return new Response("Not found", { status: 404 });

  const object = await env.FILES.get(path.slice(1));
  if (!object) return new Response("Not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(object.body, { headers });
}

// 分享標題/描述沒有另外設定時，沿用網頁標題/描述
function seoValue(content, field) {
  const pick = (key, type) => {
    const c = content.get(key);
    return c && c.type === type ? c.value : null;
  };

  switch (field) {
    case "title": return pick("seo.title", "plain");
    case "description": return pick("seo.description", "plain");
    case "og-title": return pick("seo.og-title", "plain") ?? pick("seo.title", "plain");
    case "og-description": return pick("seo.og-description", "plain") ?? pick("seo.description", "plain");
    case "og-image": {
      const v = pick("seo.og-image", "image");
      return v ? SITE_ORIGIN + v : null;
    }
    default: return null;
  }
}

const ROBOTS_TXT = [
  "User-agent: *",
  "Allow: /",
  "Disallow: /admin",
  "Disallow: /api/",
  "Disallow: /*?cms-edit=",
  "",
  "Sitemap: https://www.full-home.com.tw/sitemap.xml",
  ""
].join("\n");

// 每一頁的最後更新時間 = 影響該頁內容的資料表中最新的 updated_at
const SITEMAP_PAGES = [
  { loc: "/", sources: ["content", "faqs", "board", "docs:*"] },
  { loc: "/investors/", sources: ["company", "board", "docs:*"] },
  { loc: "/investors/company.html", sources: ["company"] },
  { loc: "/investors/governance.html", sources: ["board", "docs:公司治理"] },
  { loc: "/investors/shareholders.html", sources: ["docs:股東會"] },
  { loc: "/investors/financial.html", sources: ["docs:財務資訊", "docs:法說會"] },
  { loc: "/investors/sustainability.html", sources: ["docs:永續發展"] },
  { loc: "/investors/stock.html", sources: ["company"] },
  { loc: "/investors/contact.html", sources: ["company"] }
];

async function renderSitemap(env) {
  const one = async (sql, ...args) => {
    try {
      const r = await env.DB.prepare(sql).bind(...args).first();
      return r && r.t ? String(r.t) : null;
    } catch {
      return null;
    }
  };

  const latest = {
    content: await one("SELECT MAX(updated_at) AS t FROM site_content"),
    faqs: await one("SELECT MAX(updated_at) AS t FROM faqs"),
    board: await one("SELECT MAX(updated_at) AS t FROM board_members"),
    company: await one("SELECT MAX(updated_at) AS t FROM company_profile")
  };
  const docRows = await (async () => {
    try {
      return (await env.DB.prepare(
        "SELECT category, MAX(COALESCE(updated_at, published_at)) AS t FROM documents WHERE is_public = 1 GROUP BY category"
      ).all()).results || [];
    } catch {
      return [];
    }
  })();
  const docs = new Map(docRows.map((r) => [r.category, r.t]));

  const toW3C = (t) => {
    // D1 的 CURRENT_TIMESTAMP 為 UTC「YYYY-MM-DD HH:MM:SS」
    const d = new Date(String(t).replace(" ", "T") + (String(t).includes("Z") ? "" : "Z"));
    // 以台灣日期表示
    return isNaN(d) ? null : new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  };

  const urls = SITEMAP_PAGES.map((p) => {
    const times = [];
    for (const src of p.sources) {
      if (src === "docs:*") times.push(...docs.values());
      else if (src.startsWith("docs:")) times.push(docs.get(src.slice(5)));
      else times.push(latest[src]);
    }
    const last = times.filter(Boolean).map(toW3C).filter(Boolean).sort().pop();
    return "  <url><loc>" + SITE_ORIGIN + p.loc + "</loc>" + (last ? "<lastmod>" + last + "</lastmod>" : "") + "</url>";
  });

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join("\n") + "\n</urlset>\n";

  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" }
  });
}


// ===== 版面：區塊排序 / 隱藏 / 複製，以及文字、框框樣式 =====
// HTML 裡用 data-box-list 標記一組可排序的區塊、data-box 標記每個框框。
// 設定存在 site_content：layout.<組名>（排列）、style.<文字代碼>（文字樣式）、bstyle.<框框代碼>（框框樣式）。
// 所有樣式值都經過白名單轉成 CSS，不接受任何自由輸入的 CSS 字串。

const TEXT_COLORS = {
  navy: "#0D045F", blue: "#0A0AA3", orange: "#FF7000", "orange-soft": "#ff9b4d",
  ink: "#17172a", gray: "#68687a", white: "#ffffff", red: "#c62828"
};
const TEXT_SIZES = { xs: "0.8em", sm: "0.9em", lg: "1.2em", xl: "1.45em", xxl: "1.8em" };
const BOX_SHADOWS = {
  none: "none",
  sm: "0 4px 12px rgba(13,4,95,.08)",
  md: "0 12px 30px rgba(13,4,95,.12)",
  lg: "0 24px 60px rgba(13,4,95,.18)"
};
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const BOX_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseJsonValue(v) {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(String(v));
  } catch {
    return null;
  }
}

function intIn(v, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function normalizeTextStyle(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  if (TEXT_SIZES[v.size]) out.size = v.size;
  if (TEXT_COLORS[v.color]) out.color = v.color;
  if (v.bold === true || v.bold === false) out.bold = v.bold;
  if (v.italic === true) out.italic = true;
  if (v.underline === true) out.underline = true;
  if (["left", "center", "right"].includes(v.align)) out.align = v.align;
  return Object.keys(out).length ? out : null;
}

function textStyleCss(st) {
  const inner = [];
  const block = [];
  if (st.size) inner.push("font-size:" + TEXT_SIZES[st.size]);
  if (st.color) inner.push("color:" + TEXT_COLORS[st.color]);
  if (st.bold === true) inner.push("font-weight:800");
  if (st.bold === false) inner.push("font-weight:400");
  if (st.italic) inner.push("font-style:italic");
  if (st.underline) inner.push("text-decoration:underline");
  if (st.align) block.push("text-align:" + st.align);
  return { inner: inner.join(";"), block: block.join(";") };
}

function normalizeBoxStyle(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  if (v.bg === "transparent" || HEX_RE.test(v.bg || "")) out.bg = v.bg;
  if (HEX_RE.test(v.color || "")) out.color = v.color;
  if (HEX_RE.test(v.borderColor || "")) out.borderColor = v.borderColor;
  const bw = intIn(v.borderWidth, 0, 8);
  if (bw !== undefined) out.borderWidth = bw;
  const r = intIn(v.radius, 0, 48);
  if (r !== undefined) out.radius = r;
  if (BOX_SHADOWS[v.shadow]) out.shadow = v.shadow;
  const p = intIn(v.padding, 0, 80);
  if (p !== undefined) out.padding = p;
  const m = intIn(v.marginY, 0, 80);
  if (m !== undefined) out.marginY = m;
  return Object.keys(out).length ? out : null;
}

function boxStyleCss(st) {
  const css = [];
  if (st.bg) css.push("background:" + st.bg);
  if (st.color) css.push("color:" + st.color);
  if (st.borderWidth !== undefined) css.push("border-width:" + st.borderWidth + "px", "border-style:solid");
  if (st.borderColor) css.push("border-color:" + st.borderColor);
  if (st.radius !== undefined) css.push("border-radius:" + st.radius + "px");
  if (st.shadow) css.push("box-shadow:" + BOX_SHADOWS[st.shadow]);
  if (st.padding !== undefined) css.push("padding:" + st.padding + "px");
  if (st.marginY !== undefined) css.push("margin-top:" + st.marginY + "px", "margin-bottom:" + st.marginY + "px");
  return css.join(";");
}

function normalizeLayout(v, list) {
  if (!v || typeof v !== "object" || !BOX_ID_RE.test(list)) return null;
  const cloneRe = new RegExp("^" + list + "-c[0-9]{1,3}$");
  const order = Array.isArray(v.order) ? v.order.filter((x) => typeof x === "string" && BOX_ID_RE.test(x)).slice(0, 80) : [];
  const hidden = Array.isArray(v.hidden) ? v.hidden.filter((x) => order.includes(x)).slice(0, 80) : [];
  const clones = {};
  let n = 0;
  if (v.clones && typeof v.clones === "object") {
    for (const [id, src] of Object.entries(v.clones)) {
      if (n >= 30) break;
      if (cloneRe.test(id) && typeof src === "string" && BOX_ID_RE.test(src) && order.includes(id)) {
        clones[id] = src;
        n++;
      }
    }
  }
  return { order: [...new Set(order)], hidden: [...new Set(hidden)], clones };
}

// ---- 簡易 HTML 標籤掃描（只用在 data-box-list 容器內，找出每個框框的完整範圍）----
const LAYOUT_VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

function layoutTagRe() {
  return /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
}

function elementEnd(html, start) {
  const re = layoutTagRe();
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    const name = m[2].toLowerCase();
    if (m[1]) depth--;
    else if (!LAYOUT_VOID.has(name) && !/\/\s*$/.test(m[3])) depth++;
    if (depth === 0) return re.lastIndex;
  }
  return -1;
}

function childElements(html, from, to) {
  const re = layoutTagRe();
  const out = [];
  re.lastIndex = from;
  let m;
  while ((m = re.exec(html)) && m.index < to) {
    if (m[0].startsWith("<!--") || m[1]) continue;
    const end = elementEnd(html, m.index);
    if (end < 0 || end > to) break;
    const id = (m[3].match(/\sdata-box="([^"]+)"/) || [])[1] || null;
    out.push({ start: m.index, end, id });
    re.lastIndex = end;
  }
  return out;
}

function cloneKey(key, n) {
  return key.replace(/\.c[0-9]+$/, "") + ".c" + n;
}

function makeClone(html, cloneId, sourceId) {
  const n = Number(cloneId.split("-c").pop());
  return html
    .replace(/\sid="[^"]*"/g, "")
    .replace(/\sdata-box-source="[^"]*"/g, "")
    .replace(/(data-edit(?:-img)?)="([^"]+)"/g, (all, attr, key) => attr + '="' + cloneKey(key, n) + '"')
    .replace(/\sdata-box="[^"]*"/, ' data-box="' + cloneId + '" data-box-source="' + sourceId + '"');
}

function applyLayouts(html, content, editMode) {
  for (const [key, row] of content) {
    if (row.type !== "layout" || !key.startsWith("layout.")) continue;
    const list = key.slice(7);
    const layout = normalizeLayout(parseJsonValue(row.value), list);
    if (!layout) continue;

    const marker = html.indexOf('data-box-list="' + list + '"');
    if (marker < 0) continue;
    const open = html.lastIndexOf("<", marker);
    const openEnd = html.indexOf(">", marker) + 1;
    const end = elementEnd(html, open);
    if (end < 0) continue;
    const closeStart = html.lastIndexOf("</", end);

    const kids = childElements(html, openEnd, closeStart).filter((k) => k.id);
    if (!kids.length) continue;

    const boxes = new Map(kids.map((k) => [k.id, html.slice(k.start, k.end)]));
    const originalIds = kids.map((k) => k.id);

    // 複製的框框（可能是複製品的複製品，所以重複解析直到沒有進展）
    let pending = Object.entries(layout.clones);
    for (let round = 0; round < 5 && pending.length; round++) {
      pending = pending.filter(([id, src]) => {
        if (!boxes.has(src)) return true;
        boxes.set(id, makeClone(boxes.get(src), id, src));
        return false;
      });
    }

    const order = layout.order.filter((id) => boxes.has(id));
    for (const id of originalIds) if (!order.includes(id)) order.push(id); // 網站之後新增的框框排在最後

    const sep = kids.length > 1 ? html.slice(kids[0].end, kids[1].start) : "\n";
    const parts = [];
    for (const id of order) {
      let box = boxes.get(id);
      if (layout.hidden.includes(id)) {
        if (!editMode) continue;
        box = box.replace(/^<([a-zA-Z][a-zA-Z0-9-]*)/, '<$1 data-cms-hidden="1"');
      }
      parts.push(box);
    }

    html = html.slice(0, kids[0].start) + parts.join(sep) + html.slice(kids[kids.length - 1].end);
  }
  return html;
}

function mergeStyleAttr(el, css) {
  if (!css) return;
  const cur = (el.getAttribute("style") || "").trim();
  el.setAttribute("style", (cur ? cur.replace(/;?$/, ";") : "") + css);
}

async function renderHomepage(request, env, mode) {
  mode = mode || {};
  const editMode = !!mode.edit;
  // 不帶快取條件去拿原始 HTML，避免 304 讓瀏覽器沿用舊內容
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const origin = await fetch(new Request(request.url, { method: "GET", headers, redirect: "manual" }));

  const ct = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !ct.includes("text/html")) return origin;

  let content;
  try {
    if (mode.version) {
      content = await versionContent(env, mode.version);
      if (!content) return new Response("找不到這個版本", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    } else {
      content = await loadSiteContent(env);
      if (mode.draft) content = mergeDraft(content, await loadDraft(env));
    }
  } catch (error) {
    console.error("load site content failed:", error);
    return origin;
  }

  // 有區塊排列設定時先在文字層處理（排序、隱藏、複製），再交給 HTMLRewriter 套內容與樣式
  let source = origin;
  const hasLayout = [...content.values()].some((r) => r.type === "layout");
  if (hasLayout) {
    const text = await origin.text();
    let html = text;
    try {
      html = applyLayouts(text, content, editMode);
    } catch (error) {
      console.error("apply layout failed:", error);
    }
    source = new Response(html, { status: 200, headers: origin.headers });
  }

  const get = (el, attr, type) => {
    const c = content.get(el.getAttribute(attr));
    return c && c.type === type ? c.value : null;
  };

  const styleOf = (key, type, normalize) => {
    const c = content.get(key);
    return c && c.type === type ? normalize(parseJsonValue(c.value)) : null;
  };

  const rewritten = new HTMLRewriter()
    .on("[data-edit]", {
      element(el) {
        const key = el.getAttribute("data-edit");
        const v = get(el, "data-edit", "text");
        const st = styleOf("style." + key, "tstyle", normalizeTextStyle);

        if (!st) {
          if (v !== null) el.setInnerContent(v, { html: true });
          return;
        }

        const css = textStyleCss(st);
        mergeStyleAttr(el, css.block);
        if (editMode) el.setAttribute("data-cms-tstyle", JSON.stringify(st));

        // 字級用內層 span 的 em，才會以這個元素原本的字級為基準等比放大縮小（手機版也一樣）
        if (css.inner) {
          const openTag = '<span class="cms-tx" style="' + css.inner + '">';
          if (v !== null) {
            el.setInnerContent(openTag + v + "</span>", { html: true });
          } else {
            el.prepend(openTag, { html: true });
            el.append("</span>", { html: true });
          }
        } else if (v !== null) {
          el.setInnerContent(v, { html: true });
        }
      }
    })
    .on("[data-box]", {
      element(el) {
        const st = styleOf("bstyle." + el.getAttribute("data-box"), "bstyle", normalizeBoxStyle);
        if (!st) return;
        mergeStyleAttr(el, boxStyleCss(st));
        if (editMode) el.setAttribute("data-cms-bstyle", JSON.stringify(st));
      }
    })
    .on("[data-edit-img]", {
      element(el) {
        const v = get(el, "data-edit-img", "image");
        if (v !== null) el.setAttribute("src", v);
      }
    })
    .on("[data-edit-bg]", {
      element(el) {
        const v = get(el, "data-edit-bg", "image");
        if (v !== null) el.setAttribute("style", `--edit-bg:url("${v}")`);
      }
    })
    .on("title[data-seo]", {
      element(el) {
        const v = seoValue(content, "title");
        if (v !== null) el.setInnerContent(v);
      }
    })
    .on("meta[data-seo]", {
      element(el) {
        const v = seoValue(content, el.getAttribute("data-seo"));
        if (v !== null) el.setAttribute("content", v);
      }
    })
    .on("body", {
      element(el) {
        // 預覽模式在畫面上方加一條提示，避免誤以為已經上線
        if (mode.banner) {
          el.prepend('<div style="position:fixed;left:0;right:0;bottom:0;z-index:2147483647;background:#FF7000;color:#fff;text-align:center;font:700 14px/1.2 system-ui,sans-serif;padding:10px">' +
            escHtml(mode.banner) + "｜此畫面只有後台人員看得到</div>", { html: true });
        }
      }
    })
    .transform(source);

  const out = new Response(rewritten.body, rewritten);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.delete("Content-Length");
  out.headers.set("Cache-Control", mode.edit || mode.draft || mode.version ? "private, no-store" : "no-cache");
  return out;
}


// ===== 後台帳號權限 =====
// 登入（身分驗證）由 Cloudflare Access 負責；這裡決定「登入後能改哪些區塊」。
// SUPER_ADMINS（wrangler.jsonc）永遠擁有全部權限，不會被鎖在外面。

const PERMISSIONS = ["pages", "contacts", "company", "board", "documents", "faqs", "users"];

const PERMISSION_LABELS = {
  pages: "頁面內容",
  contacts: "聯絡表單",
  company: "公司資料",
  board: "董事會管理",
  documents: "文件管理",
  faqs: "常見問題",
  users: "權限管理"
};

// 啟用權限功能前就能登入後台的帳號，先保留原本的編輯權限（不含權限管理）
const ADMIN_USER_SEED = [
  ["mis@full-home.com.tw", "馥鴻 MIS"],
  ["ira.peng@full-home.com.tw", "彭靜怡"],
  ["kevin.hsieh@full-home.com.tw", "Kevin Hsieh"]
];

let adminTableReady = false;

function superAdmins(env) {
  return String(env.SUPER_ADMINS || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function parsePermissions(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => PERMISSIONS.includes(x)))];
}

function requiredPermission(path) {
  if (path.startsWith("/api/admin/content")) return "pages";
  if (path.startsWith("/api/admin/contacts")) return "contacts";
  if (path.startsWith("/api/admin/backups")) return "users";
  if (path.startsWith("/api/admin/audit")) return "users";
  if (path.startsWith("/api/admin/company")) return "company";
  if (path.startsWith("/api/admin/board")) return "board";
  if (path.startsWith("/api/admin/documents")) return "documents";
  if (path.startsWith("/api/admin/faqs")) return "faqs";
  if (path.startsWith("/api/admin/users")) return "users";
  return null; // bootstrap 等唯讀端點：只要是開通的帳號即可
}

async function ensureAdminTable(env) {
  if (adminTableReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT,
      permissions TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT
    )
  `).run();

  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_users").first();

  if (!row || Number(row.n) === 0) {
    await env.DB.batch(
      ADMIN_USER_SEED.map(([email, name]) =>
        env.DB.prepare(
          "INSERT INTO admin_users (email, name, permissions, is_active, updated_by) VALUES (?, ?, ?, 1, 'system')"
        ).bind(email, name, "company,board,documents,faqs")
      )
    );
  }

  adminTableReady = true;
}

async function loadAdminUser(env, email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return null;

  if (superAdmins(env).includes(e)) {
    return { email: e, name: "系統管理員", permissions: [...PERMISSIONS], is_super: true };
  }

  await ensureAdminTable(env);

  const row = await env.DB.prepare(
    "SELECT * FROM admin_users WHERE lower(email) = ? AND is_active = 1"
  ).bind(e).first();

  if (!row) return null;

  return {
    id: row.id,
    email: e,
    name: row.name || "",
    permissions: parsePermissions(row.permissions),
    is_super: false
  };
}

async function listAdminUsers(env) {
  await ensureAdminTable(env);
  const result = await env.DB.prepare(
    "SELECT * FROM admin_users ORDER BY is_active DESC, email ASC"
  ).all();
  return (result.results || []).map((u) => ({ ...u, permissions: parsePermissions(u.permissions) }));
}

function normalizeAdminUser(body) {
  return {
    email: clean(body.email, 180).toLowerCase(),
    name: clean(body.name, 80),
    permissions: parsePermissions(body.permissions),
    is_active:
      body.is_active === false || body.is_active === "false" || Number(body.is_active) === 0 ? 0 : 1
  };
}

async function createAdminUser(request, env, me) {
  await ensureAdminTable(env);
  const u = normalizeAdminUser(await request.json());

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email)) {
    return json({ ok: false, message: "Email 格式不正確。" }, 400);
  }
  if (superAdmins(env).includes(u.email)) {
    return json({ ok: false, message: "此帳號是系統管理員，已擁有全部權限。" }, 400);
  }

  const exists = await env.DB.prepare(
    "SELECT id FROM admin_users WHERE lower(email) = ?"
  ).bind(u.email).first();
  if (exists) {
    return json({ ok: false, message: "此帳號已存在，請直接編輯。" }, 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO admin_users (email, name, permissions, is_active, created_at, updated_at, updated_by)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
  `).bind(u.email, u.name, u.permissions.join(","), u.is_active, me.email).run();

  return json({ ok: true, id: result.meta?.last_row_id, message: "帳號已新增。" });
}

async function updateAdminUser(request, env, me, id) {
  await ensureAdminTable(env);

  const row = await env.DB.prepare("SELECT * FROM admin_users WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, message: "找不到此帳號。" }, 404);

  if (!me.is_super && String(row.email).toLowerCase() === me.email) {
    return json({ ok: false, message: "不能修改自己的權限，請由其他管理員處理。" }, 400);
  }

  const u = normalizeAdminUser({ ...(await request.json()), email: row.email });

  await env.DB.prepare(`
    UPDATE admin_users
    SET name = ?, permissions = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ?
    WHERE id = ?
  `).bind(u.name, u.permissions.join(","), u.is_active, me.email, id).run();

  return json({ ok: true, message: "權限已更新。" });
}

async function deleteAdminUser(env, me, id) {
  await ensureAdminTable(env);

  const row = await env.DB.prepare("SELECT email FROM admin_users WHERE id = ?").bind(id).first();
  if (!row) return json({ ok: false, message: "找不到此帳號。" }, 404);

  if (!me.is_super && String(row.email).toLowerCase() === me.email) {
    return json({ ok: false, message: "不能刪除自己的帳號。" }, 400);
  }

  await env.DB.prepare("DELETE FROM admin_users WHERE id = ?").bind(id).run();
  return json({ ok: true, message: "帳號已刪除。" });
}


// ===== 常見問題 FAQ =====
// 資料表第一次使用時自動建立，並帶入官網原本的 4 題。

const FAQ_SEED = [
  ["我不知道適合都更還是危老，也可以諮詢嗎？",
   "可以。只要提供基地地址、屋齡及基本產權概況，我們就能先從初步條件協助判斷可能方向。"],
  ["只有我一戶有意願，也能先評估嗎？",
   "可以。前期先了解基地可行性與可能的更新方式，有助於後續與其他地主溝通。"],
  ["初步評估需要準備很多資料嗎？",
   "不需要一開始就準備完整文件。地址、屋齡、土地或建物概況，就足以作為第一階段了解基礎。"],
  ["都更或危老一定會增加很多坪數嗎？",
   "不一定。實際條件會受到基地大小、使用分區、法規、容積、獎勵條件與建築設計等因素影響，需個案評估。"]
];

let faqTableReady = false;

async function ensureFaqTable(env) {
  if (faqTableReady) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_public INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM faqs"
  ).first();

  if (!row || Number(row.n) === 0) {
    await env.DB.batch(
      FAQ_SEED.map(([q, a], i) =>
        env.DB.prepare(
          "INSERT INTO faqs (question, answer, sort_order, is_public) VALUES (?, ?, ?, 1)"
        ).bind(q, a, (i + 1) * 10)
      )
    );
  }

  faqTableReady = true;
}

async function listFaqs(env, publicOnly) {
  await ensureFaqTable(env);

  const sql = publicOnly
    ? `SELECT id, question, answer, sort_order
       FROM faqs WHERE is_public = 1
       ORDER BY sort_order ASC, id ASC`
    : `SELECT * FROM faqs ORDER BY sort_order ASC, id ASC`;

  const result = await env.DB.prepare(sql).all();
  return result.results || [];
}

function normalizeFaq(body) {
  return {
    question: clean(body.question, 200),
    answer: clean(body.answer, 2000),
    sort_order: toInt(body.sort_order, 0),
    is_public:
      body.is_public === false || Number(body.is_public) === 0 || body.is_public === "false"
        ? 0
        : 1
  };
}

async function createFaq(request, env) {
  await ensureFaqTable(env);
  const f = normalizeFaq(await request.json());

  if (!f.question || !f.answer) {
    return json({ ok: false, message: "問題與回答不可空白。" }, 400);
  }

  const result = await env.DB.prepare(`
    INSERT INTO faqs (question, answer, sort_order, is_public, created_at, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(f.question, f.answer, f.sort_order, f.is_public).run();

  return json({ ok: true, id: result.meta?.last_row_id, message: "常見問題已新增。" });
}

async function updateFaq(request, env, id) {
  await ensureFaqTable(env);
  const f = normalizeFaq(await request.json());

  if (!f.question || !f.answer) {
    return json({ ok: false, message: "問題與回答不可空白。" }, 400);
  }

  await env.DB.prepare(`
    UPDATE faqs
    SET question = ?, answer = ?, sort_order = ?, is_public = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(f.question, f.answer, f.sort_order, f.is_public, id).run();

  return json({ ok: true, message: "常見問題已更新。" });
}

async function deleteFaq(env, id) {
  await ensureFaqTable(env);
  await env.DB.prepare("DELETE FROM faqs WHERE id = ?").bind(id).run();
  return json({ ok: true, message: "常見問題已刪除。" });
}


// 檔頭（magic bytes）
function fileMatchesExtension(b, ext) {
  const starts = (...sig) => sig.every((v, i) => b[i] === v);
  switch (ext) {
    case "pdf": return starts(0x25, 0x50, 0x44, 0x46, 0x2d);                         // %PDF-
    case "docx": case "xlsx": case "pptx": return starts(0x50, 0x4b, 0x03, 0x04);   // ZIP（Office Open XML）
    case "doc": case "xls": case "ppt": return starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1); // OLE2
    case "jpg": case "jpeg": return starts(0xff, 0xd8, 0xff);
    case "png": return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "webp": return starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    default: return false;
  }
}

const MIME_BY_EXT = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp"
};


// ===== Cloudflare Access JWT 驗證 =====
// env.ACCESS_TEAM_DOMAIN 例：https://da-li.cloudflareaccess.com
// env.ACCESS_AUD        ：Access 應用程式的 Application Audience (AUD) Tag

let accessKeysCache = { keys: null, fetchedAt: 0 };

async function getAccessKeys(teamDomain) {
  const now = Date.now();
  if (accessKeysCache.keys && now - accessKeysCache.fetchedAt < 10 * 60 * 1000) {
    return accessKeysCache.keys;
  }
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const { keys } = await res.json();
  accessKeysCache = { keys: keys || [], fetchedAt: now };
  return accessKeysCache.keys;
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(Math.ceil(str.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function verifyAccess(request, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) return { ok: false, reason: "missing config" };

  const token =
    request.headers.get("Cf-Access-Jwt-Assertion") ||
    cookieValue(request, "CF_Authorization");
  if (!token) return { ok: false, reason: "no token" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return { ok: false, reason: "decode" };
  }

  if (header.alg !== "RS256") return { ok: false, reason: "alg" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) {
    return { ok: false, reason: "expired" };
  }
  if (payload.iss !== teamDomain) return { ok: false, reason: "iss" };

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return { ok: false, reason: "aud" };

  let keys;
  try {
    keys = await getAccessKeys(teamDomain);
  } catch (e) {
    return { ok: false, reason: "certs fetch failed" };
  }

  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    accessKeysCache.fetchedAt = 0; // 金鑰輪替時下次重新抓
    return { ok: false, reason: "kid" };
  }

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );

  if (!valid) return { ok: false, reason: "signature" };

  return { ok: true, email: payload.email || "" };
}


function json(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {

        "Content-Type":
          "application/json; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


function htmlResponse(body) {

  return new Response(
    body,
    {
      headers: {

        "Content-Type":
          "text/html; charset=utf-8",

        "Cache-Control":
          "no-store"
      }
    }
  );
}


function adminHtml() {

  return `<!DOCTYPE html>

<html lang="zh-Hant">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1"
>

<title>
馥鴻建設｜網站管理後台
</title>

<style>

:root{
  --blue:#0D045F;
  --blue2:#0A0AA3;
  --orange:#FF7000;
  --bg:#f5f6fb;
  --panel:#fff;
  --text:#171827;
  --muted:#6c7282;
  --line:#e5e7ef;
  --shadow:
    0 18px 50px
    rgba(13,4,95,.08);
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:
    "Microsoft JhengHei",
    Arial,
    sans-serif;
  background:var(--bg);
  color:var(--text);
}

button,
input,
select,
textarea{
  font:inherit;
}

.shell{
  display:grid;
  grid-template-columns:
    250px 1fr;
  min-height:100vh;
}

aside{
  background:
    linear-gradient(
      180deg,
      #0D045F,
      #090347
    );

  color:#fff;

  padding:
    28px 20px;

  position:sticky;
  top:0;
  height:100vh;
}

.brand{
  font-size:22px;
  font-weight:900;
  line-height:1.2;
}

.brand small{
  display:block;
  font-size:10px;
  letter-spacing:.15em;
  color:#c9c8ef;
  margin-top:5px;
}

.nav{
  margin-top:30px;
  display:grid;
  gap:8px;
}

.nav button{
  border:0;
  background:transparent;
  color:#d8d8ef;
  text-align:left;
  padding:12px 14px;
  border-radius:10px;
  cursor:pointer;
}

.nav button.active,
.nav button:hover{
  background:
    rgba(255,255,255,.1);
  color:#fff;
}

main{
  padding:32px;
}

.top{
  display:flex;
  justify-content:
    space-between;
  align-items:center;
  gap:20px;
  margin-bottom:24px;
}

.top h1{
  margin:0;
  color:var(--blue);
  font-size:28px;
}

.top a{
  color:var(--blue);
  font-weight:800;
  text-decoration:none;
}

.panel{
  background:var(--panel);
  border:
    1px solid var(--line);
  border-radius:18px;
  padding:24px;
  box-shadow:var(--shadow);
  margin-bottom:20px;
}

.panel h2{
  margin:
    0 0 18px;
  color:var(--blue);
}

.grid2{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:14px;
}

.field{
  display:grid;
  gap:6px;
}

.field.full{
  grid-column:
    1 / -1;
}

label{
  font-size:13px;
  font-weight:800;
  color:#4a5060;
}

input,
select,
textarea{
  width:100%;
  padding:11px 12px;
  border:
    1px solid #d9dce7;
  border-radius:10px;
  background:#fff;
}

textarea{
  min-height:90px;
  resize:vertical;
}

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-top:16px;
}

.btn{
  border:0;
  border-radius:10px;
  padding:10px 15px;
  font-weight:900;
  cursor:pointer;
}

.btn:disabled{
  opacity:.55;
  cursor:not-allowed;
}

.primary{
  background:var(--blue);
  color:#fff;
}

.orange{
  background:var(--orange);
  color:#fff;
}

.ghost{
  background:#f1f2f8;
  color:var(--blue);
}

.danger{
  background:#fff0f0;
  color:#a22;
  border:
    1px solid #f1caca;
}

.table-wrap{
  overflow:auto;
}

table{
  width:100%;
  border-collapse:collapse;
}

th,
td{
  padding:11px 10px;
  border-bottom:
    1px solid var(--line);
  text-align:left;
  vertical-align:top;
  font-size:14px;
}

th{
  color:#666d7c;
  font-size:12px;
}

.badge{
  display:inline-block;
  padding:4px 8px;
  border-radius:999px;
  background:#f0f1f8;
  color:var(--blue);
  font-size:12px;
  font-weight:800;
}

.status{
  display:none;
  margin:
    0 0 16px;
  padding:12px 14px;
  border-radius:10px;
}

.status.show{
  display:block;
}

.status.ok{
  background:#eaf7ee;
  color:#185b2a;
}

.status.err{
  background:#fff0f0;
  color:#912020;
}

.section{
  display:none;
}

.section.active{
  display:block;
}

.muted{
  color:var(--muted);
  font-size:13px;
}

.seo-grid{
  display:grid;
  grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);
  gap:24px;
}

.count-grid{
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:14px;
}

.count{
  padding:18px;
  border-radius:14px;
  background:#f7f7fc;
  border:
    1px solid var(--line);
}

.count strong{
  display:block;
  font-size:28px;
  color:var(--blue);
}

@media(
  max-width:900px
){

  .shell{
    grid-template-columns:
      1fr;
  }

  aside{
    position:relative;
    height:auto;
  }

  .nav{
    grid-template-columns:
      repeat(2,1fr);
  }

  main{
    padding:20px;
  }

  .seo-grid,
  .grid2,
  .count-grid{
    grid-template-columns:
      1fr;
  }
}


  .dropzone {
    border: 2px dashed var(--line);
    border-radius: 14px;
    padding: 22px;
    text-align: center;
    cursor: pointer;
    background: #fafbff;
  }
  .dropzone.drag {
    border-color: #f08a24;
    background: #fff6ec;
  }
  /* 浮動樣式面板：選取文字或框框時出現在左下角（側欄位置），可拖曳、可收合 */
  .style-panel {
    position: fixed;
    left: 8px;
    bottom: 8px;
    width: 324px;
    max-width: calc(100vw - 36px);
    max-height: 78vh;
    overflow: auto;
    z-index: 60;
    background: #fff;
    border-radius: 16px;
    box-shadow: 0 18px 50px rgba(13,4,95,.28);
    padding: 12px 14px;
    display: none;
    gap: 10px;
  }
  .style-panel.show { display: grid; }
  /* 面板出現時把左側欄加寬，面板放在側欄位置，不會擋到預覽畫面 */
  .shell.style-open { grid-template-columns: 340px 1fr; }
  .style-panel.collapsed .style-group, .style-panel.collapsed #styleHint { display: none; }
  .style-head { display: flex; align-items: center; gap: 8px; cursor: move; user-select: none; }
  .style-head strong { flex: 1; color: var(--blue); }
  .style-panel #styleHint { font-size: 12px; }
  .style-group { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
  .style-group.off { opacity: .45; pointer-events: none; }
  .style-title { font-weight: 800; margin-bottom: 6px; }
  .style-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 6px 0; }
  .style-label { font-size: 13px; color: var(--muted); min-width: 36px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .seg button { border: 0; background: #fff; padding: 5px 9px; cursor: pointer; font: inherit; font-size: 13px; border-right: 1px solid var(--line); }
  .seg button:last-child { border-right: 0; }
  .seg button.on { background: var(--blue); color: #fff; }
  .swatches { display: inline-flex; gap: 5px; flex-wrap: wrap; }
  .swatches button { width: 24px; height: 24px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px var(--line); cursor: pointer; padding: 0; font-size: 11px; }
  .swatches button.on { box-shadow: 0 0 0 2px #FF7000; }
  .chk { font-size: 13px; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
  .chk input { width: auto; margin: 0; }
  .style-panel.dragging { opacity: .25; pointer-events: none; }
  .btn.sm { padding: 5px 10px; font-size: 13px; }
  .style-row input[type=range] { width: 150px; padding: 0; }
  .style-row input[type=color] { width: 34px; height: 26px; padding: 0; border: 1px solid var(--line); border-radius: 6px; }
  .style-row .val { font-size: 12px; color: var(--muted); min-width: 30px; }
  #pageToolbarPanel { position: sticky; top: 0; z-index: 30; }

  .lock-bar { margin-top: 10px; padding: 10px 12px; border-radius: 10px; background: #fff3e6; color: #8a3b00; font-weight: 700; }
  .lock-cover { position: absolute; inset: 0; z-index: 5; background: rgba(245,246,251,.55); cursor: not-allowed; display: flex; align-items: flex-start; justify-content: center; }
  .lock-cover-msg { margin-top: 24px; background: #fff; border-radius: 12px; padding: 12px 18px; box-shadow: 0 10px 30px rgba(13,4,95,.18); font-weight: 700; color: #8a3b00; max-width: 80%; }
</style>

</head>

<body>

<div class="shell">

<aside>

  <div class="brand">

    馥鴻建設

    <small>
      WEBSITE ADMIN
    </small>

  </div>

  <div class="nav">

    <button
      class="active"
      data-target="dashboard"
    >
      儀表板
    </button>

    <button
      data-target="pages"
    >
      頁面內容
    </button>

    <button
      data-target="contacts"
    >
      聯絡表單
    </button>

    <button
      data-target="company"
    >
      公司資料
    </button>

    <button
      data-target="board"
    >
      董事會管理
    </button>

    <button
      data-target="documents"
    >
      文件管理
    </button>

    <button
      data-target="faqs"
    >
      常見問題
    </button>

    <button
      data-target="users"
    >
      權限管理
    </button>

    <button
      data-target="backups"
    >
      系統備份
    </button>

    <button
      data-target="audit"
    >
      操作紀錄
    </button>

  </div>

</aside>


<main>

  <div class="top">

    <h1>
      網站管理後台
    </h1>

    <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <span id="whoami" class="muted"></span>
      <a
        href="/"
        target="_blank"
      >
        開啟官網 ↗
      </a>
    </div>

  </div>


  <div
    id="status"
    class="status"
  ></div>


  <section
    id="dashboard"
    class="section active"
  >

    <div class="panel">

      <h2>
        儀表板
      </h2>

      <div class="count-grid">

        <div class="count">

          <span>
            董事資料
          </span>

          <strong
            id="boardCount"
          >
            0
          </strong>

        </div>


        <div class="count">

          <span>
            文件數量
          </span>

          <strong
            id="docCount"
          >
            0
          </strong>

        </div>


        <div class="count">

          <span>
            公開文件
          </span>

          <strong
            id="publicDocCount"
          >
            0
          </strong>

        </div>

      </div>


      <p
        class="muted"
        style="
          margin-top:18px
        "
      >

        登入之後會由 Cloudflare Access Email OTP 保護；
        本後台不保存密碼。

      </p>

    </div>

  </section>


  <section
    id="company"
    class="section"
  >

    <div class="panel">

      <h2>
        公司基本資料
      </h2>

      <form
        id="companyForm"
        class="grid2"
      >

        <div class="field">

          <label>
            公司名稱
          </label>

          <input
            name="company_name"
            required
          >

        </div>


        <div class="field">

          <label>
            英文名稱
          </label>

          <input
            name="company_name_en"
          >

        </div>


        <div class="field">

          <label>
            股票代號
          </label>

          <input
            name="stock_code"
          >

        </div>


        <div class="field">

          <label>
            公司電話
          </label>

          <input
            name="phone"
          >

        </div>


        <div class="field full">

          <label>
            公司地址
          </label>

          <input
            name="address"
          >

        </div>


        <div class="field">

          <label>
            董事長
          </label>

          <input
            name="chairman"
          >

        </div>


        <div class="field">

          <label>
            總經理
          </label>

          <input
            name="general_manager"
          >

        </div>


        <div class="field">

          <label>
            發言人
          </label>

          <input
            name="spokesperson"
          >

        </div>


        <div class="field">

          <label>
            發言人職稱
          </label>

          <input
            name="spokesperson_title"
          >

        </div>


        <div class="field">

          <label>
            發言人電話
          </label>

          <input
            name="spokesperson_phone"
          >

        </div>


        <div class="field">

          <label>
            發言人 Email
          </label>

          <input
            name="spokesperson_email"
          >

        </div>


        <div class="field">

          <label>
            代理發言人
          </label>

          <input
            name="deputy_spokesperson"
          >

        </div>


        <div class="field">

          <label>
            代理發言人職稱
          </label>

          <input
            name="deputy_spokesperson_title"
          >

        </div>


        <div class="field">

          <label>
            代理發言人電話
          </label>

          <input
            name="deputy_spokesperson_phone"
          >

        </div>


        <div class="field">

          <label>
            代理發言人 Email
          </label>

          <input
            name="deputy_spokesperson_email"
          >

        </div>


        <div class="field">

          <label>
            股務代理機構
          </label>

          <input
            name="transfer_agent"
          >

        </div>


        <div class="field">

          <label>
            股務代理電話
          </label>

          <input
            name="transfer_agent_phone"
          >

        </div>


        <div class="field full">

          <label>
            股務代理地址
          </label>

          <input
            name="transfer_agent_address"
          >

        </div>


        <div class="field full">

          <button
            class="btn primary"
            type="submit"
          >
            儲存公司資料
          </button>

        </div>

      </form>

    </div>

  </section>


  <section
    id="board"
    class="section"
  >

    <div class="panel">

      <h2>
        新增董事
      </h2>

      <form
        id="boardForm"
        class="grid2"
      >

        <div class="field">

          <label>
            類型
          </label>

          <select
            name="member_type"
          >

            <option>
              董事
            </option>

            <option>
              獨立董事
            </option>

          </select>

        </div>


        <div class="field">

          <label>
            姓名
          </label>

          <input
            name="name"
            required
          >

        </div>


        <div class="field">

          <label>
            職稱
          </label>

          <input
            name="title"
            placeholder="例如：獨立董事｜律師"
          >

        </div>


        <div class="field">

          <label>
            法人代表資訊
          </label>

          <input
            name="representative"
            placeholder="例如：達潤投資有限公司 代表人"
          >

        </div>


        <div class="field">

          <label>
            排序
          </label>

          <input
            name="sort_order"
            type="number"
            value="0"
          >

        </div>


        <div class="field">

          <label>
            公開
          </label>

          <select
            name="is_public"
          >

            <option value="true">
              公開
            </option>

            <option value="false">
              隱藏
            </option>

          </select>

        </div>


        <div class="field full">

          <label>
            備註
          </label>

          <textarea
            name="note"
          ></textarea>

        </div>


        <div class="field full">

          <button
            class="btn primary"
            type="submit"
          >
            新增董事
          </button>

        </div>

      </form>

    </div>


    <div class="panel">

      <h2>
        現有董事
      </h2>

      <div class="table-wrap">

        <table>

          <thead>

            <tr>

              <th>
                類型
              </th>

              <th>
                姓名
              </th>

              <th>
                職稱 / 代表
              </th>

              <th>
                排序
              </th>

              <th>
                狀態
              </th>

              <th>
                動作
              </th>

            </tr>

          </thead>

          <tbody
            id="boardRows"
          ></tbody>

        </table>

      </div>

    </div>

  </section>


  <section
    id="documents"
    class="section"
  >

    <div class="panel">

      <h2 id="docFormTitle">上傳文件</h2>
      <div id="docCurrentFile" class="muted" style="margin:-6px 0 12px"></div>

      <form
        id="docForm"
        class="grid2"
        enctype="multipart/form-data"
      >

        <div class="field">

          <label>
            分類
          </label>

          <select
            name="category"
          >

            <option>
              財務資訊
            </option>

            <option>
              股東會
            </option>

            <option>
              公司治理
            </option>

            <option>
              永續發展
            </option>

            <option>
              法說會
            </option>

            <option>
              其他
            </option>

          </select>

        </div>


        <div class="field">

          <label>
            子分類
          </label>

          <input
            name="subcategory"
            placeholder="例如：財務報告 / 議事手冊"
          >

        </div>


        <div class="field">

          <label>
            年度
          </label>

          <input
            name="year"
            placeholder="2026"
          >

        </div>


        <div class="field">

          <label>
            季度
          </label>

          <select
            name="quarter"
          >

            <option value="">
              不指定
            </option>

            <option>
              Q1
            </option>

            <option>
              Q2
            </option>

            <option>
              Q3
            </option>

            <option>
              Q4
            </option>

          </select>

        </div>


        <div class="field full">

          <label>標題 <span id="docTitleHint" class="muted" style="font-weight:400"></span></label>

          <input
            name="title"
            required
            placeholder="例如：2026 年第三季合併財務報告"
          >

        </div>


        <div class="field full">

          <label>
            說明
          </label>

          <textarea
            name="description"
          ></textarea>

        </div>


        <div class="field">

          <label>
            排序
          </label>

          <input
            name="sort_order"
            type="number"
            value="0"
          >

        </div>


        <div class="field">

          <label>
            公開
          </label>

          <select
            name="is_public"
          >

            <option value="true">
              公開
            </option>

            <option value="false">
              隱藏
            </option>

          </select>

        </div>


        <div class="field full">
          <label>檔案</label>
          <div id="docDrop" class="dropzone">
            <div id="docDropText">拖曳檔案到這裡，或點擊選擇（可一次選多個）</div>
            <div class="muted" style="font-size:13px;margin-top:4px">PDF、Word、Excel、PowerPoint、JPG、PNG、WebP，單檔 25 MB；大張照片會自動壓縮</div>
            <div id="docFileList" style="margin-top:8px;font-weight:700"></div>
          </div>
          <input
            name="file"
            type="file"
            multiple
            style="display:none"
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp"
          >
        </div>

        <div class="field full" style="display:flex;gap:10px;flex-direction:row">
          <button class="btn orange" type="submit" id="docSubmit">上傳並發布</button>
          <button class="btn ghost" type="button" id="docCancel" style="display:none">取消編輯</button>
        </div>

      </form>

    </div>


    <div class="panel">

      <h2>文件列表</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">
        <input id="docFilterQ" placeholder="搜尋標題、檔名、說明" style="flex:1;min-width:200px">
        <select id="docFilterCat" style="width:auto"><option value="">全部分類</option></select>
        <select id="docFilterYear" style="width:auto"><option value="">全部年度</option></select>
        <select id="docFilterVis" style="width:auto">
          <option value="">公開與隱藏</option>
          <option value="public">只看公開</option>
          <option value="hidden">只看隱藏</option>
        </select>
        <span id="docCount" class="muted"></span>
      </div>

      <div class="table-wrap">

        <table>

          <thead>

            <tr>

              <th>
                分類
              </th>

              <th>
                年度
              </th>

              <th>
                標題
              </th>

              <th>
                檔案
              </th>

              <th>
                狀態
              </th>

              <th>
                動作
              </th>

            </tr>

          </thead>

          <tbody
            id="docRows"
          ></tbody>

        </table>

      </div>

    </div>

  </section>

  <section
    id="faqs"
    class="section"
  >

    <div class="panel">

      <h2>
        新增常見問題
      </h2>

      <form
        id="faqForm"
        class="grid2"
      >

        <div class="field full">
          <label>問題</label>
          <input
            name="question"
            required
            maxlength="200"
            placeholder="例如：初步評估需要收費嗎？"
          >
        </div>

        <div class="field full">
          <label>回答</label>
          <textarea
            name="answer"
            required
            maxlength="2000"
            placeholder="可換行，前台會照樣顯示。"
          ></textarea>
        </div>

        <div class="field">
          <label>排序（數字小的在前）</label>
          <input
            name="sort_order"
            type="number"
            value="100"
          >
        </div>

        <div class="field">
          <label>公開</label>
          <select name="is_public">
            <option value="true">公開</option>
            <option value="false">隱藏</option>
          </select>
        </div>

        <div class="field full">
          <button
            class="btn primary"
            type="submit"
          >
            新增常見問題
          </button>
        </div>

      </form>

    </div>


    <div class="panel">

      <h2>
        現有常見問題
      </h2>

      <p class="muted" style="margin-top:-8px">
        儲存後官網首頁「常見問題」區塊會立即更新；隱藏的題目不會顯示在官網。
      </p>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:70px">排序</th>
              <th>問題 / 回答</th>
              <th style="width:80px">狀態</th>
              <th style="width:150px">動作</th>
            </tr>
          </thead>
          <tbody id="faqRows"></tbody>
        </table>
      </div>

    </div>

  </section>


  <section
    id="pages"
    class="section"
  >

    <div class="panel" id="pageToolbarPanel" style="padding:16px 20px">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <strong style="color:var(--blue)">首頁內容編輯</strong>
        <span class="muted">點文字直接修改；點 Logo 或「更換背景圖」上傳新圖片；框框上方有排序、複製、隱藏工具。改完先「儲存草稿」→「預覽草稿」確認 →「發布上線」。</span>
        <span style="flex:1"></span>
        <span id="pageDirty" class="badge">尚無修改</span>
        <span id="pageDraft" class="badge">沒有未發布的草稿</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px">
        <button class="btn ghost" type="button" id="pageRevertKey" disabled>還原此區塊預設</button>
        <button class="btn ghost" type="button" id="pageDiscard">放棄未存的修改</button>
        <span style="flex:1"></span>
        <button class="btn primary" type="button" id="pageSave">儲存草稿</button>
        <button class="btn ghost" type="button" id="pagePreview">預覽草稿</button>
        <button class="btn orange" type="button" id="pagePublish">發布上線</button>
        <button class="btn ghost" type="button" id="pageDraftDiscard">捨棄草稿</button>
      </div>
      <div id="pageSelected" class="muted" style="margin-top:8px">尚未選取區塊</div>
      <div id="pageLockBar" class="lock-bar" style="display:none"></div>
      <div id="stylePanel" class="style-panel">
        <div class="style-head" id="styleHead">
          <strong>樣式與框框</strong>
          <button class="btn ghost sm" type="button" id="styleCollapse">收合</button>
          <button class="btn ghost sm" type="button" id="styleClose">關閉</button>
        </div>
        <div class="style-group" id="textStyleGroup">
          <div class="style-title">文字樣式 <span class="muted" id="textStyleTarget"></span></div>
          <div class="style-row">
            <span class="style-label">大小</span>
            <div class="seg" id="tsSize">
              <button type="button" data-v="xs">特小</button>
              <button type="button" data-v="sm">小</button>
              <button type="button" data-v="">標準</button>
              <button type="button" data-v="lg">大</button>
              <button type="button" data-v="xl">特大</button>
              <button type="button" data-v="xxl">超大</button>
            </div>
          </div>
          <div class="style-row">
            <span class="style-label">顏色</span>
            <div class="swatches" id="tsColor"></div>
          </div>
          <div class="style-row">
            <span class="style-label">字型</span>
            <div class="seg" id="tsBold">
              <button type="button" data-v="">預設</button>
              <button type="button" data-v="true"><b>粗</b></button>
              <button type="button" data-v="false">細</button>
            </div>
            <label class="chk"><input type="checkbox" id="tsItalic"> <i>斜體</i></label>
            <label class="chk"><input type="checkbox" id="tsUnderline"> <u>底線</u></label>
          </div>
          <div class="style-row">
            <span class="style-label">對齊</span>
            <div class="seg" id="tsAlign">
              <button type="button" data-v="">預設</button>
              <button type="button" data-v="left">靠左</button>
              <button type="button" data-v="center">置中</button>
              <button type="button" data-v="right">靠右</button>
            </div>
            <button class="btn ghost sm" type="button" id="tsClear">清除文字樣式</button>
          </div>
        </div>

        <div class="style-group" id="boxStyleGroup">
          <div class="style-title">框框 <span class="muted" id="boxStyleTarget"></span></div>
          <div class="style-row">
            <button class="btn ghost sm" type="button" id="boxUp">↑ 往前</button>
            <button class="btn ghost sm" type="button" id="boxDown">↓ 往後</button>
            <button class="btn ghost sm" type="button" id="boxClone">複製一個</button>
            <button class="btn ghost sm" type="button" id="boxHide">隱藏</button>
            <button class="btn danger sm" type="button" id="boxDelete">刪除</button>
          </div>
          <div class="style-row">
            <span class="style-label">背景</span>
            <input type="color" id="bsBg" data-prop="bg">
            <button class="btn ghost sm" type="button" id="bsBgNone">透明</button>
            <span class="style-label">文字色</span>
            <input type="color" id="bsColor" data-prop="color">
          </div>
          <div class="style-row">
            <span class="style-label">邊框</span>
            <input type="range" min="0" max="8" id="bsBorderWidth" data-prop="borderWidth"><span class="val" data-val="borderWidth"></span>
            <input type="color" id="bsBorderColor" data-prop="borderColor" title="邊框顏色">
          </div>
          <div class="style-row">
            <span class="style-label">圓角</span>
            <input type="range" min="0" max="48" id="bsRadius" data-prop="radius"><span class="val" data-val="radius"></span>
          </div>
          <div class="style-row">
            <span class="style-label">內距</span>
            <input type="range" min="0" max="80" id="bsPadding" data-prop="padding"><span class="val" data-val="padding"></span>
          </div>
          <div class="style-row">
            <span class="style-label">外距</span>
            <input type="range" min="0" max="80" id="bsMarginY" data-prop="marginY" title="上下外距"><span class="val" data-val="marginY"></span>
          </div>
          <div class="style-row">
            <span class="style-label">陰影</span>
            <div class="seg" id="bsShadow">
              <button type="button" data-v="">預設</button>
              <button type="button" data-v="none">無</button>
              <button type="button" data-v="sm">淡</button>
              <button type="button" data-v="md">中</button>
              <button type="button" data-v="lg">深</button>
            </div>
            <button class="btn ghost sm" type="button" id="bsClear">清除框框樣式</button>
          </div>
        </div>
        <div class="muted" id="styleHint">點文字可調整文字樣式；點框框的空白處（或文字所在的框框）可調整框框、排序、複製、隱藏。框框上方的「⠿」可以直接拖曳換位置。</div>
      </div>
      <input type="file" id="pageImageInput" accept="image/jpeg,image/png,image/webp" style="display:none">
    </div>

    <div class="panel" id="seoPanel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">SEO 與分享預覽</h2>
        <button class="btn ghost" type="button" id="seoToggle">展開設定</button>
      </div>

      <div id="seoBody" style="display:none;margin-top:16px">
        <div class="seo-grid">

          <div class="grid2" style="grid-template-columns:1fr">
            <div class="field">
              <label>網頁標題（Google 搜尋結果、瀏覽器分頁）<span class="muted" data-seo-count="seo.title"></span></label>
              <input data-seo-field="seo.title" maxlength="80">
            </div>
            <div class="field">
              <label>搜尋描述（Google 搜尋結果的說明文字）<span class="muted" data-seo-count="seo.description"></span></label>
              <textarea data-seo-field="seo.description" maxlength="300" style="min-height:80px"></textarea>
            </div>
            <div class="field">
              <label>分享標題（LINE / Facebook，留空則同網頁標題）<span class="muted" data-seo-count="seo.og-title"></span></label>
              <input data-seo-field="seo.og-title" maxlength="80" placeholder="與網頁標題相同">
            </div>
            <div class="field">
              <label>分享描述（留空則同搜尋描述）<span class="muted" data-seo-count="seo.og-description"></span></label>
              <textarea data-seo-field="seo.og-description" maxlength="300" style="min-height:70px" placeholder="與搜尋描述相同"></textarea>
            </div>
            <div class="field">
              <label>分享圖片（建議 1200 × 630，JPG / PNG / WebP，5 MB 以內）</label>
              <div class="actions" style="margin-top:0">
                <button class="btn ghost" type="button" id="seoImageBtn">上傳分享圖片</button>
                <button class="btn ghost" type="button" id="seoImageReset">還原預設圖片</button>
              </div>
              <div id="seoImageHint" class="muted"></div>
            </div>
            <p class="muted" style="margin:0">
              修改後按上方「儲存草稿」→「發布上線」。Facebook / LINE 會快取舊的預覽，上線後可到
              Facebook 分享偵錯工具按「重新抓取」更新。
            </p>
          </div>

          <div>
            <label>分享預覽</label>
            <div style="border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff;margin-top:6px">
              <div style="aspect-ratio:1.91/1;background:#e9ebf3 center/cover no-repeat" id="seoPreviewImg"></div>
              <div style="padding:12px 14px;background:#f2f3f5">
                <div class="muted" style="font-size:12px;letter-spacing:.04em">WWW.FULL-HOME.COM.TW</div>
                <div id="seoPreviewTitle" style="font-weight:800;margin:4px 0;line-height:1.35"></div>
                <div id="seoPreviewDesc" class="muted" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden"></div>
              </div>
            </div>
            <label style="display:block;margin-top:16px">Google 搜尋預覽</label>
            <div style="border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:#fff;margin-top:6px">
              <div class="muted" style="font-size:12px">https://www.full-home.com.tw</div>
              <div id="seoGoogleTitle" style="color:#1a0dab;font-size:18px;margin:2px 0"></div>
              <div id="seoGoogleDesc" style="font-size:13px;color:#4d5156;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden"></div>
            </div>
          </div>

        </div>
      </div>
    </div>

    <div class="panel" id="versionPanel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">版本與還原點</h2>
        <button class="btn ghost" type="button" id="versionToggle">展開版本</button>
      </div>
      <div id="versionBody" style="display:none;margin-top:14px">
        <p class="muted" style="margin-top:0">
          每次「發布上線」或還原都會自動存一個完整版本（保留最近 50 個），可以先預覽再還原。
          標示「還原點」的版本不會被自動刪除，而且只有系統管理員可以還原。
        </p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th style="width:70px">版本</th>
                <th style="width:170px">時間</th>
                <th style="width:220px">操作人</th>
                <th>說明</th>
                <th style="width:300px"></th>
              </tr>
            </thead>
            <tbody id="versionRows"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel" id="historyPanel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h2 style="margin:0">修改紀錄</h2>
        <button class="btn ghost" type="button" id="historyToggle">展開紀錄</button>
      </div>
      <div id="historyBody" style="display:none;margin-top:14px">
        <p class="muted" style="margin-top:0">最近 40 次儲存。可以整次還原，或只還原其中一個區塊；還原也會留下一筆紀錄。</p>
        <div id="historyList"></div>
      </div>
    </div>

    <div class="panel" style="padding:0;overflow:hidden;position:relative">
      <div id="pageLockCover" class="lock-cover" style="display:none"></div>
      <iframe
        id="pageFrame"
        title="首頁編輯預覽"
        style="width:100%;height:78vh;border:0;display:block;background:#fff"
      ></iframe>
    </div>

  </section>

  <section
    id="contacts"
    class="section"
  >

    <div class="panel">
      <h2>聯絡表單紀錄</h2>

      <div id="contactSummary" class="muted" style="margin:-8px 0 14px"></div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <select id="contactStatus" style="width:auto">
          <option value="">全部狀態</option>
          <option value="new">新進件</option>
          <option value="contacted">已聯絡</option>
          <option value="closed">已結案</option>
          <option value="spam">垃圾訊息</option>
        </select>
        <input id="contactQ" placeholder="搜尋姓名、電話、地址、內容、備註" style="flex:1;min-width:220px">
        <button class="btn primary" type="button" id="contactSearch">搜尋</button>
        <a class="btn ghost" id="contactExport" href="/api/admin/contacts/export.csv" style="text-decoration:none">匯出 CSV（Excel）</a>
      </div>
    </div>

    <div class="panel">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:150px">送出時間</th>
              <th>聯絡人</th>
              <th>基地</th>
              <th style="width:110px">希望了解</th>
              <th style="width:90px">狀態</th>
              <th style="width:90px">通知信</th>
              <th style="width:80px"></th>
            </tr>
          </thead>
          <tbody id="contactRows"></tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn ghost" type="button" id="contactMore" style="display:none">載入更多</button>
      </div>
    </div>

  </section>


  <section
    id="backups"
    class="section"
  >

    <div class="panel">
      <h2>系統備份與健康檢查</h2>
      <p class="muted" style="margin-top:-8px">
        每天凌晨 2 點自動備份：資料庫完整快照（保留最近 30 份）、上傳檔案增量複製到獨立的備份空間。
        來源檔案被刪除時，備份不會跟著刪除。
      </p>
      <div id="backupSummary" style="margin:12px 0"></div>
      <div class="actions">
        <button class="btn primary" type="button" id="backupRun">立即備份</button>
        <button class="btn ghost" type="button" id="backupRefresh">重新整理</button>
        <button class="btn ghost" type="button" id="alertTest">寄送測試通知</button>
      </div>
    </div>

    <div class="panel">
      <h2>資料庫快照</h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>檔案</th>
              <th style="width:120px">大小</th>
              <th style="width:180px">建立時間</th>
              <th style="width:90px"></th>
            </tr>
          </thead>
          <tbody id="backupRows"></tbody>
        </table>
      </div>
    </div>

  </section>

  <section
    id="audit"
    class="section"
  >

    <div class="panel">
      <h2>操作紀錄</h2>
      <p class="muted" style="margin-top:-8px">後台所有新增、修改、刪除的操作，保留 2 年。</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th style="width:170px">時間</th>
              <th style="width:230px">帳號</th>
              <th>操作</th>
              <th style="width:80px">結果</th>
            </tr>
          </thead>
          <tbody id="auditRows"></tbody>
        </table>
      </div>
      <div class="actions">
        <button class="btn ghost" type="button" id="auditMore" style="display:none">載入更多</button>
      </div>
    </div>

  </section>

  <section
    id="users"
    class="section"
  >

    <div class="panel">
      <h2>新增後台帳號</h2>

      <p class="muted" style="margin-top:-8px">
        這裡決定「登入後可以改哪些區塊」。新帳號還需要加到 Cloudflare Access 的允許名單，才能收到登入驗證碼。
      </p>

      <form id="userForm" class="grid2">
        <div class="field">
          <label>Email</label>
          <input name="email" type="email" required placeholder="name@full-home.com.tw">
        </div>

        <div class="field">
          <label>姓名 / 備註</label>
          <input name="name" maxlength="80">
        </div>

        <div class="field full">
          <label>可編輯的區塊</label>
          <div id="userFormPerms" style="display:flex;gap:16px;flex-wrap:wrap"></div>
        </div>

        <div class="field full">
          <button class="btn primary" type="submit">新增帳號</button>
        </div>
      </form>
    </div>

    <div class="panel">
      <h2>帳號與權限</h2>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>帳號</th>
              <th>可編輯的區塊</th>
              <th style="width:80px">狀態</th>
              <th style="width:150px">動作</th>
            </tr>
          </thead>
          <tbody id="userRows"></tbody>
        </table>
      </div>
    </div>

  </section>

</main>

</div>
<script>

var state = {
  company: null,
  board: [],
  documents: []
};


document
  .querySelectorAll(
    ".nav button"
  )
  .forEach(
    function(btn) {

      btn.addEventListener(
        "click",
        function() {

          document
            .querySelectorAll(
              ".nav button"
            )
            .forEach(
              function(x) {
                x.classList.remove(
                  "active"
                );
              }
            );


          btn.classList.add(
            "active"
          );


          document
            .querySelectorAll(
              ".section"
            )
            .forEach(
              function(x) {
                x.classList.remove(
                  "active"
                );
              }
            );


          document
            .getElementById(
              btn.dataset.target
            )
            .classList.add(
              "active"
            );

        }
      );

    }
  );


function flash(
  message,
  ok
) {

  if (
    ok === undefined
  ) {
    ok = true;
  }


  var el =
    document.getElementById(
      "status"
    );


  el.textContent =
    message;


  el.className =
    "status show " +
    (
      ok
        ? "ok"
        : "err"
    );


  window.scrollTo({
    top: 0,
    behavior: "smooth"
  });


  setTimeout(
    function() {

      el.className =
        "status";

    },
    3500
  );
}


async function api(
  url,
  options
) {

  var r =
    await fetch(
      url,
      options || {}
    );


  var data =
    await r
      .json()
      .catch(
        function() {
          return {};
        }
      );


  if (
    !r.ok ||
    data.ok === false
  ) {

    throw new Error(
      data.message ||
      "操作失敗"
    );
  }


  return data;
}


async function load() {

  var data =
    await api(
      "/api/admin/bootstrap"
    );


  state =
    data;


  fillCompany();

  renderBoard();

  renderDocs();

  renderFaqs();

  applyPermissions();

  renderUsers();

  renderCounts();
}


function renderCounts() {

  document
    .getElementById(
      "boardCount"
    )
    .textContent =
      (
        state.board ||
        []
      ).length;


  document
    .getElementById(
      "docCount"
    )
    .textContent =
      (
        state.documents ||
        []
      ).length;


  document
    .getElementById(
      "publicDocCount"
    )
    .textContent =
      (
        state.documents ||
        []
      )
        .filter(
          function(x) {
            return !!x.is_public;
          }
        )
        .length;
}


function fillCompany() {

  var c =
    state.company ||
    {};


  var f =
    document.getElementById(
      "companyForm"
    );


  Object
    .keys(c)
    .forEach(
      function(k) {

        var el =
          f.elements[k];


        if (el) {

          el.value =
            c[k] ||
            "";
        }
      }
    );
}


document
  .getElementById(
    "companyForm"
  )
  .addEventListener(
    "submit",
    async function(e) {

      e.preventDefault();


      try {

        var body =
          Object.fromEntries(
            new FormData(
              e.target
            ).entries()
          );


        await api(
          "/api/admin/company",
          {
            method: "PUT",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                body
              )
          }
        );


        flash(
          "公司資料已儲存。"
        );


        await load();

      } catch (err) {

        flash(
          err.message,
          false
        );
      }
    }
  );


document
  .getElementById(
    "boardForm"
  )
  .addEventListener(
    "submit",
    async function(e) {

      e.preventDefault();


      try {

        var body =
          Object.fromEntries(
            new FormData(
              e.target
            ).entries()
          );


        body.is_public =
          body.is_public ===
          "true";


        await api(
          "/api/admin/board",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(
                body
              )
          }
        );


        e.target.reset();


        flash(
          "董事資料已新增。"
        );


        await load();

      } catch (err) {

        flash(
          err.message,
          false
        );
      }
    }
  );


function renderBoard() {
  var tbody = document.getElementById("boardRows");
  tbody.innerHTML = "";

  (state.board || []).forEach(function(m) {
    var tr = document.createElement("tr");
    tr.dataset.boardId = m.id;

    tr.innerHTML =
      '<td data-field="member_type">' + esc(m.member_type) + '</td>' +
      '<td data-field="name"><strong>' + esc(m.name) + '</strong></td>' +
      '<td data-field="title_rep">' +
        esc(m.title || m.representative || "") +
      '</td>' +
      '<td data-field="sort_order">' + esc(m.sort_order || 0) + '</td>' +
      '<td data-field="is_public"><span class="badge">' +
        (m.is_public ? "公開" : "隱藏") +
      '</span></td>' +
      '<td data-actions>' +
        '<button class="btn ghost" data-edit-board="' + m.id + '">編輯</button> ' +
        '<button class="btn danger" data-delete-board="' + m.id + '">刪除</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-edit-board]").forEach(function(btn) {
    btn.onclick = function() {
      startBoardEdit(Number(btn.dataset.editBoard));
    };
  });

  tbody.querySelectorAll("[data-delete-board]").forEach(function(btn) {
    btn.onclick = function() {
      removeBoard(Number(btn.dataset.deleteBoard));
    };
  });
}

function startBoardEdit(id) {
  var m = (state.board || []).find(function(x) {
    return x.id === id;
  });

  if (!m) return;

  var tr = document.querySelector(
    'tr[data-board-id="' + id + '"]'
  );

  if (!tr) return;

  tr.querySelector('[data-field="member_type"]').innerHTML =
    '<select data-edit="member_type">' +
      '<option value="董事"' + (m.member_type === "董事" ? " selected" : "") + '>董事</option>' +
      '<option value="獨立董事"' + (m.member_type === "獨立董事" ? " selected" : "") + '>獨立董事</option>' +
    '</select>';

  tr.querySelector('[data-field="name"]').innerHTML =
    '<input data-edit="name" value="' + escAttr(m.name || "") + '">';

  tr.querySelector('[data-field="title_rep"]').innerHTML =
    '<div style="display:grid;gap:6px">' +
      '<input data-edit="title" placeholder="職稱" value="' + escAttr(m.title || "") + '">' +
      '<input data-edit="representative" placeholder="代表 / 法人資訊" value="' + escAttr(m.representative || "") + '">' +
    '</div>';

  tr.querySelector('[data-field="sort_order"]').innerHTML =
    '<input data-edit="sort_order" type="number" value="' +
    Number(m.sort_order || 0) +
    '" style="max-width:90px">';

  tr.querySelector('[data-field="is_public"]').innerHTML =
    '<select data-edit="is_public">' +
      '<option value="true"' + (m.is_public ? " selected" : "") + '>公開</option>' +
      '<option value="false"' + (!m.is_public ? " selected" : "") + '>隱藏</option>' +
    '</select>';

  tr.querySelector("[data-actions]").innerHTML =
    '<button class="btn primary" data-save-board="' + id + '">儲存</button> ' +
    '<button class="btn ghost" data-cancel-board="' + id + '">取消</button>';

  tr.querySelector("[data-save-board]").onclick = function() {
    saveBoardInline(id);
  };

  tr.querySelector("[data-cancel-board]").onclick = function() {
    renderBoard();
  };
}


async function saveBoardInline(id) {
  var m = (state.board || []).find(function(x) {
    return x.id === id;
  });

  if (!m) return;

  var tr = document.querySelector(
    'tr[data-board-id="' + id + '"]'
  );

  if (!tr) return;

  var body = {
    member_type:
      tr.querySelector('[data-edit="member_type"]').value,

    name:
      tr.querySelector('[data-edit="name"]').value.trim(),

    title:
      tr.querySelector('[data-edit="title"]').value.trim(),

    representative:
      tr.querySelector('[data-edit="representative"]').value.trim(),

    note:
      m.note || "",

    sort_order:
      Number(
        tr.querySelector('[data-edit="sort_order"]').value
      ) || 0,

    is_public:
      tr.querySelector('[data-edit="is_public"]').value === "true"
  };

  if (!body.name) {
    flash("姓名不可空白。", false);
    return;
  }

  var saveBtn = tr.querySelector("[data-save-board]");
  saveBtn.disabled = true;
  saveBtn.textContent = "儲存中…";

  try {
    await api(
      "/api/admin/board/" + id,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    flash("董事資料已更新。");

    await load();

  } catch (err) {
    flash(err.message, false);

    saveBtn.disabled = false;
    saveBtn.textContent = "儲存";
  }
}


function escAttr(v) {
  return String(v == null ? "" : v)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function removeBoard(
  id
) {

  if (
    !confirm(
      "確定刪除此董事資料？"
    )
  ) {
    return;
  }


  try {

    await api(
      "/api/admin/board/" +
      id,
      {
        method:
          "DELETE"
      }
    );


    flash(
      "董事資料已刪除。"
    );


    await load();

  } catch (err) {

    flash(
      err.message,
      false
    );
  }
}


// ===== 圖片壓縮（瀏覽器端，不佔 Worker CPU、免費）=====
// 長邊縮到 maxSide 以內、重新編碼；壓縮後反而變大就用原檔。順便去掉照片裡的 GPS 等 EXIF。
async function compressImage(file, opts) {
  opts = opts || {};
  var maxSide = opts.maxSide || 2400;
  var type = opts.type || (file.type === "image/png" ? "image/webp" : file.type === "image/webp" ? "image/webp" : "image/jpeg");
  var quality = opts.quality || 0.82;

  if (["image/jpeg", "image/png", "image/webp"].indexOf(file.type) < 0) return file;

  var bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    return file;
  }

  var scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  var w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);

  // 尺寸本來就小、檔案也小（< 300 KB）就不動
  if (scale === 1 && file.size < 300 * 1024 && !opts.force) {
    bmp.close && bmp.close();
    return file;
  }

  var canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  var ctx = canvas.getContext("2d");
  if (type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();

  var blob = await new Promise(function(resolve) { canvas.toBlob(resolve, type, quality); });
  // 瀏覽器不支援 WebP 編碼時會回傳 PNG，改用 JPEG
  if (blob && blob.type !== type) {
    type = "image/jpeg";
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    blob = await new Promise(function(resolve) { canvas.toBlob(resolve, type, quality); });
  }
  if (!blob || (blob.size >= file.size && scale === 1)) return file;

  var ext = type === "image/webp" ? ".webp" : ".jpg";
  var base = baseName(file.name || "image");
  return new File([blob], base + ext, { type: type });
}

function baseName(name) {
  var i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function extOf(name) {
  var i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}


// ===== 文件管理 =====

var docState = { editing: 0, files: [] };
var docForm = document.getElementById("docForm");
var docFileInput = docForm.querySelector('input[name="file"]');
var docDrop = document.getElementById("docDrop");

function docSetFiles(list) {
  docState.files = Array.prototype.slice.call(list || []);
  if (docState.editing && docState.files.length > 1) docState.files = docState.files.slice(0, 1);
  var names = docState.files.map(function(f) { return f.name + "（" + fmtSize(f.size) + "）"; });
  document.getElementById("docFileList").textContent = names.length
    ? (names.length > 1 ? "已選 " + names.length + " 個檔案：" : "已選：") + names.join("、")
    : "";
  var multi = !docState.editing && docState.files.length > 1;
  document.getElementById("docTitleHint").textContent = multi ? "多檔上傳時，標題留白會用各檔案名稱；有填則全部使用同一個標題加序號。" : "";
  docForm.querySelector('input[name="title"]').required = !multi && !docState.editing;
}

docFileInput.addEventListener("change", function() { docSetFiles(docFileInput.files); });

["dragenter", "dragover"].forEach(function(ev) {
  docDrop.addEventListener(ev, function(e) { e.preventDefault(); docDrop.classList.add("drag"); });
});
["dragleave", "drop"].forEach(function(ev) {
  docDrop.addEventListener(ev, function(e) { e.preventDefault(); docDrop.classList.remove("drag"); });
});
docDrop.addEventListener("drop", function(e) { docSetFiles(e.dataTransfer.files); });
docDrop.addEventListener("click", function() { docFileInput.click(); });

async function prepareDocFile(f) {
  // 文件裡的圖片：保持原格式（避免副檔名改變），只縮尺寸、重新壓縮；PNG 不動
  var ext = extOf(f.name);
  if ((ext === "jpg" || ext === "jpeg" || ext === "webp") && f.size > 300 * 1024) {
    var type = ext === "webp" ? "image/webp" : "image/jpeg";
    var c = await compressImage(f, { maxSide: 3000, type: type, quality: 0.85 });
    if (c !== f) return new File([c], f.name, { type: type });
  }
  return f;
}

function docFields() {
  var fd = new FormData(docForm);
  return {
    category: fd.get("category"),
    subcategory: fd.get("subcategory") || "",
    year: fd.get("year") || "",
    quarter: fd.get("quarter") || "",
    title: (fd.get("title") || "").trim(),
    description: fd.get("description") || "",
    sort_order: Number(fd.get("sort_order")) || 0,
    is_public: fd.get("is_public") !== "false"
  };
}

docForm.addEventListener("submit", async function(e) {
  e.preventDefault();
  var btn = document.getElementById("docSubmit");
  var f = docFields();

  try {
    btn.disabled = true;

    if (docState.editing) {
      btn.textContent = "儲存中…";
      if (!f.title) throw new Error("標題不可空白。");
      await api("/api/admin/documents/" + docState.editing, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f)
      });
      if (docState.files.length) {
        btn.textContent = "更換檔案中…";
        var rf = new FormData();
        rf.append("file", await prepareDocFile(docState.files[0]));
        await api("/api/admin/documents/" + docState.editing + "/file", { method: "POST", body: rf });
      }
      flash(docState.files.length ? "文件資料已更新，檔案已更換（連結不變）。" : "文件資料已更新。");
      docCancelEdit();
      await load();
      return;
    }

    if (!docState.files.length) throw new Error("請選擇檔案。");
    var total = docState.files.length, done = 0, failed = [];

    for (var i = 0; i < total; i++) {
      var file = docState.files[i];
      btn.textContent = "上傳中 " + (i + 1) + "/" + total + "…";
      var fd = new FormData();
      var title = total === 1
        ? f.title
        : (f.title ? f.title + "（" + (i + 1) + "）" : baseName(file.name));
      fd.append("category", f.category);
      fd.append("subcategory", f.subcategory);
      fd.append("year", f.year);
      fd.append("quarter", f.quarter);
      fd.append("title", title);
      fd.append("description", f.description);
      fd.append("sort_order", String(f.sort_order + i));
      fd.append("is_public", f.is_public ? "true" : "false");
      fd.append("file", await prepareDocFile(file));
      try {
        await api("/api/admin/documents", { method: "POST", body: fd });
        done++;
      } catch (err) {
        failed.push(file.name + "：" + err.message);
      }
    }

    if (failed.length) {
      flash("已上傳 " + done + " 個，失敗 " + failed.length + " 個：" + failed.join("；"), false);
    } else {
      flash(total > 1 ? "已上傳 " + total + " 個文件。" : "文件已上傳。");
    }
    docForm.reset();
    docSetFiles([]);
    await load();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = docState.editing ? "儲存修改" : "上傳並發布";
  }
});

function editDoc(id) {
  var d = (state.documents || []).find(function(x) { return x.id === id; });
  if (!d) return;
  docState.editing = id;
  var el = docForm.elements;
  var cat = el.category;
  if (!Array.prototype.some.call(cat.options, function(o) { return o.value === d.category; })) {
    var o = document.createElement("option");
    o.textContent = d.category;
    cat.appendChild(o);
  }
  cat.value = d.category;
  el.subcategory.value = d.subcategory || "";
  el.year.value = d.year || "";
  el.quarter.value = d.quarter || "";
  el.title.value = d.title || "";
  el.description.value = d.description || "";
  el.sort_order.value = d.sort_order || 0;
  el.is_public.value = d.is_public ? "true" : "false";
  docFileInput.value = "";
  docFileInput.multiple = false;
  docSetFiles([]);
  document.getElementById("docFormTitle").textContent = "編輯文件 #" + id;
  document.getElementById("docCurrentFile").innerHTML =
    "目前檔案：" + esc(d.file_name || "") + "（" + fmtSize(d.file_size) + "）　" +
    '<a href="/api/admin/documents/' + id + '/file" target="_blank">預覽</a>　' +
    '<span class="muted">要更換檔案再選新檔；前台連結不會變。</span>';
  document.getElementById("docDropText").textContent = "拖曳新檔案到這裡，或點擊選擇（選填）";
  document.getElementById("docSubmit").textContent = "儲存修改";
  document.getElementById("docCancel").style.display = "";
  docForm.scrollIntoView({ behavior: "smooth", block: "start" });
}

function docCancelEdit() {
  docState.editing = 0;
  docForm.reset();
  docFileInput.multiple = true;
  docSetFiles([]);
  document.getElementById("docFormTitle").textContent = "上傳文件";
  document.getElementById("docCurrentFile").innerHTML = "";
  document.getElementById("docDropText").textContent = "拖曳檔案到這裡，或點擊選擇（可一次選多個）";
  document.getElementById("docSubmit").textContent = "上傳並發布";
  document.getElementById("docCancel").style.display = "none";
}

document.getElementById("docCancel").addEventListener("click", docCancelEdit);

function renderDocs() {
  var docs = state.documents || [];
  var fq = document.getElementById("docFilterQ").value.trim().toLowerCase();
  var fc = document.getElementById("docFilterCat").value;
  var fy = document.getElementById("docFilterYear").value;
  var fv = document.getElementById("docFilterVis").value;

  // 篩選選項依現有資料產生
  var cats = {}, years = {};
  docs.forEach(function(d) { cats[d.category] = 1; if (d.year) years[d.year] = 1; });
  fillFilter("docFilterCat", Object.keys(cats).sort(), "全部分類");
  fillFilter("docFilterYear", Object.keys(years).sort().reverse(), "全部年度");

  var list = docs.filter(function(d) {
    if (fc && d.category !== fc) return false;
    if (fy && d.year !== fy) return false;
    if (fv === "public" && !d.is_public) return false;
    if (fv === "hidden" && d.is_public) return false;
    if (fq) {
      var hay = [d.title, d.subcategory, d.description, d.file_name, d.category].join(" ").toLowerCase();
      if (hay.indexOf(fq) < 0) return false;
    }
    return true;
  });

  document.getElementById("docCount").textContent = "共 " + docs.length + " 份，顯示 " + list.length + " 份";

  var tbody = document.getElementById("docRows");
  tbody.innerHTML = list.length ? "" : '<tr><td colspan="6" class="muted">沒有符合的文件。</td></tr>';

  list.forEach(function(d) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(d.category) + '<br><span class="muted">' + esc(d.subcategory || "") + "</span></td>" +
      "<td>" + esc((d.year || "") + " " + (d.quarter || "")) + "</td>" +
      "<td><strong>" + esc(d.title) + "</strong>" +
        '<div class="muted">更新：' + esc(twTime(d.updated_at || d.created_at || d.published_at)) + "</div></td>" +
      '<td><a href="/api/admin/documents/' + d.id + '/file" target="_blank">' + esc(d.file_name || "檔案") + "</a>" +
        '<div class="muted">' + fmtSize(d.file_size) + "</div></td>" +
      '<td><span class="badge">' + (d.is_public ? "公開" : "隱藏") + "</span>" +
        (d.is_public ? '<div><a class="muted" href="/files/' + d.id + '" target="_blank">前台連結</a></div>' : "") + "</td>" +
      "<td>" +
        '<button class="btn ghost" type="button" data-edit-doc="' + d.id + '">編輯</button> ' +
        '<button class="btn ghost" type="button" data-toggle-doc="' + d.id + '">' + (d.is_public ? "隱藏" : "公開") + "</button> " +
        '<button class="btn danger" type="button" data-delete-doc="' + d.id + '">刪除</button>' +
      "</td>";
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-edit-doc]").forEach(function(btn) {
    btn.onclick = function() { editDoc(Number(btn.dataset.editDoc)); };
  });
  tbody.querySelectorAll("[data-toggle-doc]").forEach(function(btn) {
    btn.onclick = function() { toggleDoc(Number(btn.dataset.toggleDoc)); };
  });
  tbody.querySelectorAll("[data-delete-doc]").forEach(function(btn) {
    btn.onclick = function() { removeDoc(Number(btn.dataset.deleteDoc)); };
  });
}

function fillFilter(id, values, allLabel) {
  var sel = document.getElementById(id);
  var cur = sel.value;
  sel.innerHTML = '<option value="">' + allLabel + "</option>" +
    values.map(function(v) { return '<option value="' + escAttr(v) + '">' + esc(v) + "</option>"; }).join("");
  if (values.indexOf(cur) >= 0) sel.value = cur;
}

["docFilterQ", "docFilterCat", "docFilterYear", "docFilterVis"].forEach(function(id) {
  document.getElementById(id).addEventListener(id === "docFilterQ" ? "input" : "change", renderDocs);
});

async function toggleDoc(id) {
  var d = (state.documents || []).find(function(x) { return x.id === id; });
  if (!d) return;
  try {
    await api("/api/admin/documents/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        category: d.category, subcategory: d.subcategory || "", year: d.year || "", quarter: d.quarter || "",
        title: d.title, description: d.description || "", sort_order: d.sort_order || 0, is_public: !d.is_public
      })
    });
    flash(d.is_public ? "已隱藏（前台約 5 分鐘內完全消失）。" : "已公開。");
    await load();
  } catch (err) {
    flash(err.message, false);
  }
}

async function removeDoc(id) {
  var d = (state.documents || []).find(function(x) { return x.id === id; });
  if (!confirm("確定刪除「" + (d ? d.title : "#" + id) + "」？檔案也會一起刪除（每日備份裡仍保留副本）。")) return;
  try {
    await api("/api/admin/documents/" + id, { method: "DELETE" });
    if (docState.editing === id) docCancelEdit();
    flash("文件已刪除。");
    await load();
  } catch (err) {
    flash(err.message, false);
  }
}


// ===== 權限 =====

var SECTION_PERMISSION = {
  pages: "pages",
  contacts: "contacts",
  backups: "users",
  audit: "users",
  company: "company",
  board: "board",
  documents: "documents",
  faqs: "faqs",
  users: "users"
};

function can(perm) {
  return !!(state.me && (state.me.permissions || []).indexOf(perm) >= 0);
}

function permLabel(p) {
  return (state.permission_labels || {})[p] || p;
}

function applyPermissions() {
  var me = state.me || { permissions: [] };

  document.getElementById("whoami").textContent = me.is_super
    ? "登入身分：" + me.email + "｜系統管理員"
    : "登入身分：" + (me.name ? me.name + "（" + me.email + "）" : me.email);

  document.querySelectorAll(".nav button").forEach(function(btn) {
    var need = SECTION_PERMISSION[btn.dataset.target];
    btn.style.display = !need || can(need) ? "" : "none";
  });

  var active = document.querySelector(".nav button.active");
  if (active && active.style.display === "none") {
    document.querySelector('.nav button[data-target="dashboard"]').click();
  }
}

function permCheckboxes(selected, attr) {
  return Object.keys(state.permission_labels || {}).map(function(p) {
    var checked = (selected || []).indexOf(p) >= 0 ? " checked" : "";
    return '<label style="display:inline-flex;gap:6px;align-items:center;font-weight:600">' +
      '<input type="checkbox" ' + attr + ' value="' + p + '"' + checked + ' style="width:auto">' +
      esc(permLabel(p)) + '</label>';
  }).join(" ");
}

function renderUsers() {
  if (!can("users")) return;

  var formBox = document.getElementById("userFormPerms");
  if (!formBox.dataset.ready) {
    formBox.innerHTML = permCheckboxes(["faqs"], "data-new-perm");
    formBox.dataset.ready = "1";
  }

  var tbody = document.getElementById("userRows");
  tbody.innerHTML = "";

  (state.super_admins || []).forEach(function(email) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><strong>' + esc(email) + '</strong><div class="muted">系統管理員（設定檔）</div></td>' +
      '<td>全部</td>' +
      '<td><span class="badge">啟用</span></td>' +
      '<td class="muted">由設定檔管理</td>';
    tbody.appendChild(tr);
  });

  (state.users || []).forEach(function(u) {
    var tr = document.createElement("tr");
    tr.dataset.userId = u.id;

    var labels = (u.permissions || []).map(permLabel).join("、") || '<span class="muted">（無）</span>';

    tr.innerHTML =
      '<td><strong>' + esc(u.email) + '</strong><div class="muted">' + esc(u.name || "") + '</div></td>' +
      '<td data-field="perms">' + labels + '</td>' +
      '<td data-field="active"><span class="badge">' + (u.is_active ? "啟用" : "停用") + '</span></td>' +
      '<td data-actions>' +
        '<button class="btn ghost" data-edit-user="' + u.id + '">編輯</button> ' +
        '<button class="btn danger" data-delete-user="' + u.id + '">刪除</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-edit-user]").forEach(function(btn) {
    btn.onclick = function() { startUserEdit(Number(btn.dataset.editUser)); };
  });

  tbody.querySelectorAll("[data-delete-user]").forEach(function(btn) {
    btn.onclick = function() { removeUser(Number(btn.dataset.deleteUser)); };
  });
}

function startUserEdit(id) {
  var u = (state.users || []).find(function(x) { return x.id === id; });
  if (!u) return;

  var tr = document.querySelector('tr[data-user-id="' + id + '"]');

  tr.querySelector('[data-field="perms"]').innerHTML =
    '<input data-edit="name" placeholder="姓名 / 備註" value="' + escAttr(u.name || "") + '" style="margin-bottom:8px">' +
    '<div style="display:flex;gap:12px;flex-wrap:wrap">' + permCheckboxes(u.permissions, "data-edit-perm") + '</div>';

  tr.querySelector('[data-field="active"]').innerHTML =
    '<select data-edit="is_active">' +
      '<option value="true"' + (u.is_active ? " selected" : "") + '>啟用</option>' +
      '<option value="false"' + (!u.is_active ? " selected" : "") + '>停用</option>' +
    '</select>';

  tr.querySelector("[data-actions]").innerHTML =
    '<button class="btn primary" data-save-user>儲存</button> ' +
    '<button class="btn ghost" data-cancel-user>取消</button>';

  tr.querySelector("[data-save-user]").onclick = function() { saveUser(id); };
  tr.querySelector("[data-cancel-user]").onclick = function() { renderUsers(); };
}

async function saveUser(id) {
  var tr = document.querySelector('tr[data-user-id="' + id + '"]');

  var body = {
    name: tr.querySelector('[data-edit="name"]').value.trim(),
    is_active: tr.querySelector('[data-edit="is_active"]').value === "true",
    permissions: Array.prototype.map.call(
      tr.querySelectorAll("[data-edit-perm]:checked"),
      function(x) { return x.value; }
    )
  };

  try {
    await api("/api/admin/users/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    flash("權限已更新。");
    await load();
  } catch (err) {
    flash(err.message, false);
  }
}

async function removeUser(id) {
  if (!confirm("確定刪除此帳號的後台權限？")) return;

  try {
    await api("/api/admin/users/" + id, { method: "DELETE" });
    flash("帳號已刪除。");
    await load();
  } catch (err) {
    flash(err.message, false);
  }
}

document
  .getElementById("userForm")
  .addEventListener("submit", async function(e) {
    e.preventDefault();

    var body = {
      email: e.target.elements.email.value.trim(),
      name: e.target.elements.name.value.trim(),
      is_active: true,
      permissions: Array.prototype.map.call(
        e.target.querySelectorAll("[data-new-perm]:checked"),
        function(x) { return x.value; }
      )
    };

    try {
      await api("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      e.target.reset();
      flash("帳號已新增。");
      await load();
    } catch (err) {
      flash(err.message, false);
    }
  });


// ===== 頁面內容（視覺化編輯）=====

var pageEditor = {
  dirty: {},
  selectedKey: null,
  imageTarget: null,
  loaded: false
};

function pageDirtyCount() {
  return Object.keys(pageEditor.dirty).length;
}

function updatePageToolbar() {
  var n = pageDirtyCount();
  document.getElementById("pageDirty").textContent = n ? ("未儲存修改：" + n + " 處") : "尚無修改";
  document.getElementById("pageSave").disabled = !n;
  if (typeof renderDraftBadge === "function") renderDraftBadge();
  if (typeof pageLock !== "undefined" && !pageLock.mine) {
    ["pageSave", "pagePublish", "pageDraftDiscard", "pageRevertKey"].forEach(function(id) {
      document.getElementById(id).disabled = true;
    });
  }

  var key = pageEditor.selectedKey;
  var overridden = key && ((state.content_keys || []).indexOf(key) >= 0 || pageEditor.dirty[key]);
  document.getElementById("pageRevertKey").disabled = !overridden;
  document.getElementById("pageSelected").textContent = key
    ? ("目前選取：" + key + (overridden ? "（已修改過）" : "（原始內容）"))
    : "尚未選取區塊";
}

function loadPageFrame() {
  pageEditor.dirty = {};
  pageEditor.selectedKey = null;
  pageEditor.selectedEl = null;
  pageEditor.selectedBox = null;
  pageEditor.hoverBox = null;
  pageEditor.dragBox = null;
  if (typeof updateStylePanel === "function") updateStylePanel();
  updatePageToolbar();
  var frame = document.getElementById("pageFrame");
  frame.onload = setupPageFrame;
  frame.src = "/?cms-edit=1&t=" + Date.now();
  pageEditor.loaded = true;
}

function setupPageFrame() {
  var frame = document.getElementById("pageFrame");
  var doc = frame.contentDocument;
  if (!doc) return;

  var style = doc.createElement("style");
  style.textContent =
    "[data-reveal]{opacity:1!important;transform:none!important;transition:none!important}" +
    "[data-edit]{cursor:text}" +
    "[data-edit]:hover{outline:2px dashed #FF7000;outline-offset:3px}" +
    "[data-edit].cms-active{outline:2px solid #FF7000;outline-offset:3px;background:rgba(255,112,0,.06)}" +
    "[data-edit].cms-dirty{box-shadow:0 0 0 4px rgba(255,112,0,.18)}" +
    "[data-edit-img]{cursor:pointer}" +
    "[data-edit-img]:hover{outline:2px dashed #FF7000;outline-offset:3px}" +
    ".cms-bg-btn{position:absolute;top:84px;right:16px;z-index:50;background:#FF7000;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25)}" +
    "[data-box]:hover{outline:1px dashed rgba(10,10,163,.45);outline-offset:4px}" +
    "[data-box].cms-box-selected{outline:2px solid #0A0AA3;outline-offset:4px}" +
    "[data-cms-hidden]{opacity:.35!important;filter:grayscale(1)}" +
    "[data-box].cms-dragging{opacity:.55;outline:2px dashed #FF7000!important}" +
    "body.cms-drag-mode,body.cms-drag-mode *{cursor:grabbing!important;user-select:none!important}" +
    "#cms-boxbar{position:absolute;z-index:2147483000;display:none;gap:2px;background:#0A0AA3;border-radius:8px;padding:3px;box-shadow:0 6px 18px rgba(0,0,0,.25);font:600 12px/1 system-ui,sans-serif}" +
    "#cms-boxbar button{border:0;background:transparent;color:#fff;padding:6px 8px;border-radius:5px;cursor:pointer;font:inherit}" +
    "#cms-boxbar button:hover{background:rgba(255,255,255,.18)}" +
    "#cms-boxbar button[data-act=drag]{cursor:grab}" +
    "#cms-boxbar button[data-act=delete]{color:#ffb4b4}";
  doc.head.appendChild(style);

  doc.querySelectorAll("[data-edit-bg]").forEach(function(sec) {
    if (getComputedStyle(sec).position === "static") sec.style.position = "relative";
    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "cms-bg-btn";
    btn.textContent = "更換背景圖";
    btn.addEventListener("click", function(e) {
      e.preventDefault();
      e.stopPropagation();
      pickPageImage(sec.getAttribute("data-edit-bg"), sec, "bg");
    });
    sec.appendChild(btn);
  });

  doc.addEventListener("click", function(e) {
    var link = e.target.closest("a");
    if (link) e.preventDefault();

    var img = e.target.closest("[data-edit-img]");
    if (img) {
      e.preventDefault();
      pickPageImage(img.getAttribute("data-edit-img"), img, "img");
      return;
    }

    var el = e.target.closest("[data-edit]");
    if (!el) {
      if (e.target.closest("#cms-boxbar")) return;
      var box = e.target.closest("[data-box]");
      if (box) {
        e.preventDefault();
        selectBox(box);
      }
      return;
    }
    e.preventDefault();
    activatePageText(el);
  }, true);

  doc.addEventListener("submit", function(e) { e.preventDefault(); }, true);

  setupLayoutEditing(doc);
  doc.addEventListener("mousemove", markPageActivity, { passive: true });
  doc.addEventListener("keydown", markPageActivity);
  fillSeoForm(doc);
  loadDraftCount();
}

function activatePageText(el) {
  var doc = el.ownerDocument;
  doc.querySelectorAll(".cms-active").forEach(function(x) {
    x.classList.remove("cms-active");
    x.removeAttribute("contenteditable");
  });

  el.classList.add("cms-active");
  el.setAttribute("contenteditable", "true");
  el.focus();

  pageEditor.selectedKey = el.getAttribute("data-edit");
  pageEditor.selectedEl = el;
  selectBox(el.closest("[data-box]"));
  updatePageToolbar();

  if (!el.dataset.cmsBound) {
    el.dataset.cmsBound = "1";

    el.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        doc.execCommand("insertLineBreak");
      }
    });

    el.addEventListener("paste", function(e) {
      e.preventDefault();
      var text = (e.clipboardData || window.clipboardData).getData("text/plain");
      doc.execCommand("insertText", false, text);
    });

    el.addEventListener("input", function() {
      pageEditor.dirty[el.getAttribute("data-edit")] = { type: "text", value: textTarget(el).innerHTML };
      el.classList.add("cms-dirty");
      updatePageToolbar();
    });
  }
}

function pickPageImage(key, target, kind) {
  pageEditor.imageTarget = { key: key, el: target, kind: kind };
  pageEditor.selectedKey = key;
  updatePageToolbar();
  var input = document.getElementById("pageImageInput");
  input.value = "";
  input.click();
}

document.getElementById("pageImageInput").addEventListener("change", async function(e) {
  var file = e.target.files && e.target.files[0];
  var t = pageEditor.imageTarget;
  if (!file || !t) return;

  // 上傳前在瀏覽器壓縮：背景大圖長邊 2400、一般圖片 1600、分享圖 1200（用 JPEG，各平台都支援）
  var original = file.size;
  try {
    flash("圖片處理中…");
    file = t.kind === "seo"
      ? await compressImage(file, { maxSide: 1200, type: "image/jpeg", quality: 0.85, force: true })
      : await compressImage(file, { maxSide: t.kind === "img" ? 1600 : 2400 });
  } catch (err) {
    console.warn("compress failed", err);
  }

  if (file.size > 5 * 1024 * 1024) {
    flash("圖片壓縮後仍超過 5 MB，請換一張。", false);
    return;
  }

  var fd = new FormData();
  fd.append("file", file);

  try {
    flash("圖片上傳中…");
    var data = await api("/api/admin/content/image", { method: "POST", body: fd });

    if (t.kind === "img") {
      t.el.setAttribute("src", data.url);
    } else if (t.kind === "seo") {
      seoState.image = data.url;
      document.getElementById("seoImageHint").textContent = "已上傳新的分享圖片，儲存後生效";
      updateSeoPreview();
    } else {
      t.el.style.setProperty("--edit-bg", "url(" + JSON.stringify(data.url) + ")");
    }

    pageEditor.dirty[t.key] = { type: "image", value: data.url };
    updatePageToolbar();
    flash("圖片已上傳" + (file.size < original ? "（" + fmtSize(original) + " → " + fmtSize(file.size) + "）" : "") + "，按「儲存草稿」後再發布上線。");
  } catch (err) {
    flash(err.message, false);
  }
});

// ===== 版面與樣式（文字大小顏色、框框樣式、排序、複製、隱藏）=====

var TS_SIZES = { xs: "0.8em", sm: "0.9em", lg: "1.2em", xl: "1.45em", xxl: "1.8em" };
var TS_COLORS = [
  ["", "預設", "linear-gradient(135deg,#fff 45%,#d33 46%,#d33 54%,#fff 55%)"],
  ["navy", "深藍", "#0D045F"],
  ["blue", "藍", "#0A0AA3"],
  ["orange", "橘", "#FF7000"],
  ["orange-soft", "淺橘", "#ff9b4d"],
  ["ink", "黑", "#17172a"],
  ["gray", "灰", "#68687a"],
  ["white", "白", "#ffffff"],
  ["red", "紅", "#c62828"]
];
var TS_COLOR_HEX = {};
TS_COLORS.forEach(function(c) { if (c[0]) TS_COLOR_HEX[c[0]] = c[2]; });
var BS_SHADOWS = {
  none: "none",
  sm: "0 4px 12px rgba(13,4,95,.08)",
  md: "0 12px 30px rgba(13,4,95,.12)",
  lg: "0 24px 60px rgba(13,4,95,.18)"
};
var LIST_LABELS = {
  "hero-stats": "首頁亮點", focus: "公司重點", points: "簡介重點", services: "服務項目", why: "選擇我們",
  partners: "合作夥伴", investors: "投資人專區", steps: "合作流程", cta: "聯絡步驟"
};

function readJsonAttr(el, attr) {
  try {
    return JSON.parse(el.getAttribute(attr) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function compactStyle(st) {
  var out = {};
  Object.keys(st).forEach(function(k) {
    if (st[k] !== undefined && st[k] !== null && st[k] !== "") out[k] = st[k];
  });
  return out;
}

// 文字實際的編輯目標：有樣式時內容包在 span.cms-tx 裡
function textTarget(el) {
  var w = el.firstElementChild;
  if (w && w.classList.contains("cms-tx") && el.childNodes.length === 1) return w;
  return el;
}

function ensureTextWrap(el) {
  var t = textTarget(el);
  if (t !== el) return t;
  var w = el.ownerDocument.createElement("span");
  w.className = "cms-tx";
  while (el.firstChild) w.appendChild(el.firstChild);
  el.appendChild(w);
  return w;
}

function textCss(st) {
  var css = [];
  if (st.size) css.push("font-size:" + TS_SIZES[st.size]);
  if (st.color) css.push("color:" + TS_COLOR_HEX[st.color]);
  if (st.bold === true) css.push("font-weight:800");
  if (st.bold === false) css.push("font-weight:400");
  if (st.italic) css.push("font-style:italic");
  if (st.underline) css.push("text-decoration:underline");
  return css.join(";");
}

function setTextStyle(el, st) {
  st = compactStyle(st);
  var key = el.getAttribute("data-edit");
  pageEditor.dirty["style." + key] = Object.keys(st).length ? { type: "tstyle", value: st } : null;
  el.setAttribute("data-cms-tstyle", JSON.stringify(st));
  var css = textCss(st);
  if (css) ensureTextWrap(el).style.cssText = css;
  else if (textTarget(el) !== el) textTarget(el).style.cssText = "";
  el.style.textAlign = st.align || "";
  el.classList.add("cms-dirty");
  updatePageToolbar();
  updateStylePanel();
  positionBoxBar();
}

function boxCss(st) {
  var css = [];
  if (st.bg) css.push("background:" + st.bg);
  if (st.color) css.push("color:" + st.color);
  if (st.borderWidth !== undefined) css.push("border-width:" + st.borderWidth + "px", "border-style:solid");
  if (st.borderColor) css.push("border-color:" + st.borderColor);
  if (st.radius !== undefined) css.push("border-radius:" + st.radius + "px");
  if (st.shadow) css.push("box-shadow:" + BS_SHADOWS[st.shadow]);
  if (st.padding !== undefined) css.push("padding:" + st.padding + "px");
  if (st.marginY !== undefined) css.push("margin-top:" + st.marginY + "px", "margin-bottom:" + st.marginY + "px");
  return css.join(";");
}

function setBoxStyle(box, st) {
  st = compactStyle(st);
  var id = box.getAttribute("data-box");
  pageEditor.dirty["bstyle." + id] = Object.keys(st).length ? { type: "bstyle", value: st } : null;
  box.setAttribute("data-cms-bstyle", JSON.stringify(st));
  box.style.cssText = boxCss(st);
  updatePageToolbar();
  updateStylePanel();
  positionBoxBar();
}

// ---- 框框排列 ----

function boxContainer(box) {
  var p = box && box.parentElement;
  return p && p.hasAttribute("data-box-list") ? p : null;
}

function boxesIn(container) {
  return Array.prototype.filter.call(container.children, function(c) { return c.hasAttribute("data-box"); });
}

function markLayout(container) {
  var list = container.getAttribute("data-box-list");
  var boxes = boxesIn(container);
  var clones = {};
  boxes.forEach(function(b) {
    if (b.getAttribute("data-box-source")) clones[b.getAttribute("data-box")] = b.getAttribute("data-box-source");
  });
  pageEditor.dirty["layout." + list] = {
    type: "layout",
    value: {
      order: boxes.map(function(b) { return b.getAttribute("data-box"); }),
      hidden: boxes.filter(function(b) { return b.hasAttribute("data-cms-hidden"); }).map(function(b) { return b.getAttribute("data-box"); }),
      clones: clones
    }
  };
  updatePageToolbar();
  updateStylePanel();
  positionBoxBar();
}

function moveBox(box, dir) {
  var c = boxContainer(box);
  if (!c) return;
  var boxes = boxesIn(c);
  var i = boxes.indexOf(box);
  var j = i + dir;
  if (j < 0 || j >= boxes.length) return;
  if (dir < 0) c.insertBefore(box, boxes[j]);
  else c.insertBefore(box, boxes[j].nextSibling);
  markLayout(c);
}

function baseKey(k) {
  var i = k.search(/[.]c[0-9]+$/);
  return i >= 0 ? k.slice(0, i) : k;
}

function cleanEditorMarks(root) {
  var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll("*")));
  all.forEach(function(n) {
    n.classList.remove("cms-active", "cms-dirty", "cms-box-selected", "cms-dragging");
    n.removeAttribute("contenteditable");
    n.removeAttribute("data-cms-bound");
    n.removeAttribute("id");
  });
}

function cloneBox(box) {
  var c = boxContainer(box);
  if (!c) return;
  var list = c.getAttribute("data-box-list");
  var max = 0;
  c.ownerDocument.querySelectorAll('[data-box^="' + list + '-c"]').forEach(function(b) {
    var n = Number(b.getAttribute("data-box").slice(list.length + 2));
    if (n > max) max = n;
  });
  if (max >= 30) {
    flash("同一組最多複製 30 個。", false);
    return;
  }
  var n = max + 1;
  var id = list + "-c" + n;
  var copy = box.cloneNode(true);
  cleanEditorMarks(copy);
  copy.removeAttribute("data-cms-hidden");
  copy.setAttribute("data-box", id);
  copy.setAttribute("data-box-source", box.getAttribute("data-box"));

  copy.querySelectorAll("[data-edit]").forEach(function(el) {
    var k = baseKey(el.getAttribute("data-edit")) + ".c" + n;
    el.setAttribute("data-edit", k);
    pageEditor.dirty[k] = { type: "text", value: textTarget(el).innerHTML };
    var st = readJsonAttr(el, "data-cms-tstyle");
    if (Object.keys(st).length) pageEditor.dirty["style." + k] = { type: "tstyle", value: st };
  });
  copy.querySelectorAll("[data-edit-img]").forEach(function(el) {
    var k = baseKey(el.getAttribute("data-edit-img")) + ".c" + n;
    el.setAttribute("data-edit-img", k);
    var src = el.getAttribute("src") || "";
    if (src.indexOf("/media/") === 0) pageEditor.dirty[k] = { type: "image", value: src };
  });
  var bst = readJsonAttr(box, "data-cms-bstyle");
  if (Object.keys(bst).length) pageEditor.dirty["bstyle." + id] = { type: "bstyle", value: bst };

  box.parentNode.insertBefore(copy, box.nextSibling);
  markLayout(c);
  selectBox(copy);
  flash("已複製，點新框框裡的文字就能修改。");
}

function toggleHideBox(box) {
  var c = boxContainer(box);
  if (!c) return;
  if (box.hasAttribute("data-cms-hidden")) box.removeAttribute("data-cms-hidden");
  else box.setAttribute("data-cms-hidden", "1");
  markLayout(c);
}

function deleteBox(box) {
  var c = boxContainer(box);
  if (!c || !box.getAttribute("data-box-source")) return;
  if (!confirm("刪除這個複製出來的框框？（按儲存後生效）")) return;
  box.querySelectorAll("[data-edit]").forEach(function(el) {
    var k = el.getAttribute("data-edit");
    pageEditor.dirty[k] = null;
    pageEditor.dirty["style." + k] = null;
  });
  box.querySelectorAll("[data-edit-img]").forEach(function(el) {
    pageEditor.dirty[el.getAttribute("data-edit-img")] = null;
  });
  pageEditor.dirty["bstyle." + box.getAttribute("data-box")] = null;
  if (pageEditor.selectedEl && box.contains(pageEditor.selectedEl)) pageEditor.selectedEl = null;
  box.remove();
  pageEditor.selectedBox = null;
  markLayout(c);
}

// ---- 選取 ----

function selectBox(box) {
  var doc = document.getElementById("pageFrame").contentDocument;
  if (doc) doc.querySelectorAll(".cms-box-selected").forEach(function(x) { x.classList.remove("cms-box-selected"); });
  pageEditor.selectedBox = box || null;
  if (box) box.classList.add("cms-box-selected");
  updateStylePanel();
  positionBoxBar();
}

function boxName(box) {
  var c = boxContainer(box);
  var id = box.getAttribute("data-box");
  if (!c) return id;
  var list = c.getAttribute("data-box-list");
  var idx = boxesIn(c).indexOf(box) + 1;
  return (LIST_LABELS[list] || list) + " 第 " + idx + " 個" + (box.getAttribute("data-box-source") ? "（複製）" : "") +
    (box.hasAttribute("data-cms-hidden") ? "（已隱藏）" : "");
}

// ---- 框框上方的小工具列（在預覽畫面裡）----

function positionBoxBar() {
  var frame = document.getElementById("pageFrame");
  var doc = frame.contentDocument;
  if (!doc) return;
  var bar = doc.getElementById("cms-boxbar");
  if (!bar) return;
  var box = pageEditor.hoverBox || pageEditor.selectedBox;
  if (!box || !box.isConnected) {
    bar.style.display = "none";
    return;
  }
  var win = frame.contentWindow;
  var r = box.getBoundingClientRect();
  var inList = !!boxContainer(box);
  bar.querySelector('[data-act="drag"]').style.display = inList ? "" : "none";
  bar.querySelector('[data-act="up"]').style.display = inList ? "" : "none";
  bar.querySelector('[data-act="down"]').style.display = inList ? "" : "none";
  bar.querySelector('[data-act="clone"]').style.display = inList ? "" : "none";
  bar.querySelector('[data-act="hide"]').style.display = inList ? "" : "none";
  bar.querySelector('[data-act="hide"]').textContent = box.hasAttribute("data-cms-hidden") ? "顯示" : "隱藏";
  bar.querySelector('[data-act="delete"]').style.display = box.getAttribute("data-box-source") ? "" : "none";
  bar.style.display = "flex";
  var top = r.top + win.scrollY - 34;
  if (r.top < 40) top = r.top + win.scrollY + 4;
  bar.style.top = top + "px";
  bar.style.left = Math.max(4, r.left + win.scrollX) + "px";
}

function setupLayoutEditing(doc) {
  var win = doc.defaultView;

  var bar = doc.createElement("div");
  bar.id = "cms-boxbar";
  bar.innerHTML =
    '<button type="button" data-act="drag" title="按住拖曳換位置">⠿ 拖曳</button>' +
    '<button type="button" data-act="up" title="往前">↑</button>' +
    '<button type="button" data-act="down" title="往後">↓</button>' +
    '<button type="button" data-act="clone">複製</button>' +
    '<button type="button" data-act="hide">隱藏</button>' +
    '<button type="button" data-act="delete">刪除</button>' +
    '<button type="button" data-act="style">樣式</button>';
  doc.body.appendChild(bar);

  bar.addEventListener("mouseenter", function() { pageEditor.overBar = true; });
  bar.addEventListener("mouseleave", function() { pageEditor.overBar = false; });

  bar.addEventListener("click", function(e) {
    var b = e.target.closest("button");
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var box = pageEditor.hoverBox || pageEditor.selectedBox;
    if (!box) return;
    var act = b.getAttribute("data-act");
    if (act === "up") moveBox(box, -1);
    if (act === "down") moveBox(box, 1);
    if (act === "clone") cloneBox(box);
    if (act === "hide") toggleHideBox(box);
    if (act === "delete") deleteBox(box);
    if (act === "style") {
      selectBox(box);
      document.getElementById("pageToolbarPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, true);

  doc.addEventListener("mouseover", function(e) {
    if (pageEditor.dragBox || pageEditor.overBar) return;
    if (e.target.closest && e.target.closest("#cms-boxbar")) return;
    var box = e.target.closest ? e.target.closest("[data-box]") : null;
    if (box !== pageEditor.hoverBox) {
      pageEditor.hoverBox = box;
      positionBoxBar();
    }
  });

  win.addEventListener("scroll", positionBoxBar, { passive: true });
  win.addEventListener("resize", positionBoxBar);

  // 拖曳排序：按住「⠿ 拖曳」移動滑鼠，放開即完成
  bar.querySelector('[data-act="drag"]').addEventListener("mousedown", function(e) {
    var box = pageEditor.hoverBox || pageEditor.selectedBox;
    if (!box || !boxContainer(box)) return;
    e.preventDefault();
    pageEditor.dragBox = box;
    box.classList.add("cms-dragging");
    doc.body.classList.add("cms-drag-mode");
    document.getElementById("stylePanel").classList.add("dragging");
  });

  // 拖曳到預覽畫面上下邊緣時自動捲動
  var edgeTimer = null;
  var edgeDir = 0;
  function edgeScroll() {
    if (!pageEditor.dragBox || !edgeDir) {
      clearInterval(edgeTimer);
      edgeTimer = null;
      return;
    }
    win.scrollBy(0, edgeDir * 18);
  }

  doc.addEventListener("mousemove", function(e) {
    var box = pageEditor.dragBox;
    if (!box) return;
    e.preventDefault();
    edgeDir = e.clientY < 70 ? -1 : (e.clientY > win.innerHeight - 70 ? 1 : 0);
    if (edgeDir && !edgeTimer) edgeTimer = setInterval(edgeScroll, 30);
    bar.style.display = "none";
    var under = doc.elementFromPoint(e.clientX, e.clientY);
    var target = under && under.closest ? under.closest("[data-box]") : null;
    while (target && target.parentElement !== box.parentElement) {
      target = target.parentElement ? target.parentElement.closest("[data-box]") : null;
    }
    if (!target || target === box) return;
    var r = target.getBoundingClientRect();
    var sibs = boxesIn(box.parentElement);
    var horizontal = sibs.length > 1 && Math.abs(sibs[0].getBoundingClientRect().top - sibs[1].getBoundingClientRect().top) < 8;
    var after = horizontal ? (e.clientX > r.left + r.width / 2) : (e.clientY > r.top + r.height / 2);
    box.parentElement.insertBefore(box, after ? target.nextSibling : target);
  });

  function endDrag() {
    var box = pageEditor.dragBox;
    if (!box) return;
    pageEditor.dragBox = null;
    box.classList.remove("cms-dragging");
    doc.body.classList.remove("cms-drag-mode");
    document.getElementById("stylePanel").classList.remove("dragging");
    markLayout(box.parentElement);
    selectBox(box);
  }
  doc.addEventListener("mouseup", endDrag);
  // 滑鼠移出預覽畫面才放開時也要結束拖曳
  window.addEventListener("mouseup", endDrag);
}

// ---- 上方樣式面板 ----

function setSeg(id, value) {
  document.querySelectorAll("#" + id + " button").forEach(function(b) {
    b.classList.toggle("on", b.getAttribute("data-v") === (value === undefined ? "" : String(value)));
  });
}

function rgbToHex(c) {
  var m = String(c || "").match(/[0-9.]+/g);
  if (!m || m.length < 3) return "#ffffff";
  return "#" + m.slice(0, 3).map(function(x) { var h = Math.round(Number(x)).toString(16); return h.length < 2 ? "0" + h : h; }).join("");
}

function updateStylePanel() {
  var el = pageEditor.selectedEl && pageEditor.selectedEl.isConnected ? pageEditor.selectedEl : null;
  var box = pageEditor.selectedBox && pageEditor.selectedBox.isConnected ? pageEditor.selectedBox : null;

  var panel = document.getElementById("stylePanel");
  var onPages = document.getElementById("pages").classList.contains("active");
  var show = onPages && !!(el || box);
  if (panel.classList.contains("show") !== show) {
    panel.classList.toggle("show", show);
    var shell = document.querySelector(".shell");
    if (shell) shell.classList.toggle("style-open", show && !panel.style.top);
    setTimeout(positionBoxBar, 50);
  }

  document.getElementById("textStyleGroup").classList.toggle("off", !el);
  document.getElementById("textStyleTarget").textContent = el ? el.getAttribute("data-edit") : "（先點選一段文字）";
  var ts = el ? readJsonAttr(el, "data-cms-tstyle") : {};
  setSeg("tsSize", ts.size);
  setSeg("tsBold", ts.bold);
  setSeg("tsAlign", ts.align);
  document.getElementById("tsItalic").checked = !!ts.italic;
  document.getElementById("tsUnderline").checked = !!ts.underline;
  document.querySelectorAll("#tsColor button").forEach(function(b) {
    b.classList.toggle("on", b.getAttribute("data-v") === (ts.color || ""));
  });

  document.getElementById("boxStyleGroup").classList.toggle("off", !box);
  document.getElementById("boxStyleTarget").textContent = box ? boxName(box) : "（先點選一個框框）";
  var bs = box ? readJsonAttr(box, "data-cms-bstyle") : {};
  var cs = box ? box.ownerDocument.defaultView.getComputedStyle(box) : null;
  var inList = !!(box && boxContainer(box));
  document.getElementById("boxUp").disabled = !inList;
  document.getElementById("boxDown").disabled = !inList;
  document.getElementById("boxClone").disabled = !inList;
  document.getElementById("boxHide").disabled = !inList;
  document.getElementById("boxHide").textContent = box && box.hasAttribute("data-cms-hidden") ? "取消隱藏" : "隱藏";
  document.getElementById("boxDelete").disabled = !(box && box.getAttribute("data-box-source"));

  document.getElementById("bsBg").value = bs.bg && bs.bg !== "transparent" ? bs.bg : rgbToHex(cs && cs.backgroundColor);
  document.getElementById("bsColor").value = bs.color || rgbToHex(cs && cs.color);
  document.getElementById("bsBorderColor").value = bs.borderColor || rgbToHex(cs && cs.borderTopColor);
  [["bsBorderWidth", "borderWidth", "borderTopWidth"], ["bsRadius", "radius", "borderTopLeftRadius"],
   ["bsPadding", "padding", "paddingTop"], ["bsMarginY", "marginY", "marginTop"]].forEach(function(x) {
    var input = document.getElementById(x[0]);
    var v = bs[x[1]];
    input.value = v !== undefined ? v : Math.min(Number(input.max), parseInt(cs ? cs[x[2]] : 0, 10) || 0);
    document.querySelector('[data-val="' + x[1] + '"]').textContent = v !== undefined ? v + "px" : "預設";
  });
  setSeg("bsShadow", bs.shadow);
}

function updateSelectedText(patch) {
  var el = pageEditor.selectedEl;
  if (!el) return;
  var st = readJsonAttr(el, "data-cms-tstyle");
  Object.keys(patch).forEach(function(k) { st[k] = patch[k]; });
  setTextStyle(el, st);
}

function updateSelectedBox(patch) {
  var box = pageEditor.selectedBox;
  if (!box) return;
  var st = readJsonAttr(box, "data-cms-bstyle");
  Object.keys(patch).forEach(function(k) { st[k] = patch[k]; });
  setBoxStyle(box, st);
}

(function initStylePanel() {
  var sw = document.getElementById("tsColor");
  sw.innerHTML = TS_COLORS.map(function(c) {
    return '<button type="button" data-v="' + c[0] + '" title="' + c[1] + '" style="background:' + c[2] + '"></button>';
  }).join("");
  sw.addEventListener("click", function(e) {
    var b = e.target.closest("button");
    if (b) updateSelectedText({ color: b.getAttribute("data-v") || undefined });
  });

  function segHandler(id, apply, parse) {
    document.getElementById(id).addEventListener("click", function(e) {
      var b = e.target.closest("button");
      if (!b) return;
      var v = b.getAttribute("data-v");
      apply(v === "" ? undefined : (parse ? parse(v) : v));
    });
  }
  segHandler("tsSize", function(v) { updateSelectedText({ size: v }); });
  segHandler("tsBold", function(v) { updateSelectedText({ bold: v }); }, function(v) { return v === "true"; });
  segHandler("tsAlign", function(v) { updateSelectedText({ align: v }); });
  segHandler("bsShadow", function(v) { updateSelectedBox({ shadow: v }); });

  document.getElementById("tsItalic").addEventListener("change", function() { updateSelectedText({ italic: this.checked || undefined }); });
  document.getElementById("tsUnderline").addEventListener("change", function() { updateSelectedText({ underline: this.checked || undefined }); });
  document.getElementById("tsClear").addEventListener("click", function() { if (pageEditor.selectedEl) setTextStyle(pageEditor.selectedEl, {}); });

  ["bsBg", "bsColor", "bsBorderColor"].forEach(function(id) {
    document.getElementById(id).addEventListener("input", function() {
      var p = {};
      p[this.getAttribute("data-prop")] = this.value;
      updateSelectedBox(p);
    });
  });
  ["bsBorderWidth", "bsRadius", "bsPadding", "bsMarginY"].forEach(function(id) {
    document.getElementById(id).addEventListener("input", function() {
      var p = {};
      p[this.getAttribute("data-prop")] = Number(this.value);
      updateSelectedBox(p);
    });
  });
  document.getElementById("bsBgNone").addEventListener("click", function() { updateSelectedBox({ bg: "transparent" }); });
  document.getElementById("bsClear").addEventListener("click", function() { if (pageEditor.selectedBox) setBoxStyle(pageEditor.selectedBox, {}); });

  document.getElementById("boxUp").addEventListener("click", function() { if (pageEditor.selectedBox) moveBox(pageEditor.selectedBox, -1); });
  document.getElementById("boxDown").addEventListener("click", function() { if (pageEditor.selectedBox) moveBox(pageEditor.selectedBox, 1); });
  document.getElementById("boxClone").addEventListener("click", function() { if (pageEditor.selectedBox) cloneBox(pageEditor.selectedBox); });
  document.getElementById("boxHide").addEventListener("click", function() { if (pageEditor.selectedBox) toggleHideBox(pageEditor.selectedBox); });
  document.getElementById("boxDelete").addEventListener("click", function() { if (pageEditor.selectedBox) deleteBox(pageEditor.selectedBox); });

  document.getElementById("styleCollapse").addEventListener("click", function() {
    var p = document.getElementById("stylePanel");
    p.classList.toggle("collapsed");
    this.textContent = p.classList.contains("collapsed") ? "展開" : "收合";
  });
  document.getElementById("styleClose").addEventListener("click", function() {
    var doc = document.getElementById("pageFrame").contentDocument;
    if (doc) doc.querySelectorAll(".cms-active").forEach(function(x) { x.classList.remove("cms-active"); x.removeAttribute("contenteditable"); });
    pageEditor.selectedEl = null;
    selectBox(null);
  });

  // 面板可以拖到別的位置，避免擋住要改的地方
  var head = document.getElementById("styleHead");
  head.addEventListener("mousedown", function(e) {
    if (e.target.closest("button")) return;
    var p = document.getElementById("stylePanel");
    var r = p.getBoundingClientRect();
    var dx = e.clientX - r.left, dy = e.clientY - r.top;
    function move(ev) {
      p.style.left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx)) + "px";
      p.style.top = Math.max(0, Math.min(window.innerHeight - 60, ev.clientY - dy)) + "px";
      p.style.bottom = "auto";
    }
    function up() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    }
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    e.preventDefault();
  });

  // 切換到其他後台頁面時隱藏面板
  document.querySelectorAll(".nav button[data-target]").forEach(function(b) {
    b.addEventListener("click", function() { setTimeout(updateStylePanel, 0); });
  });

  updateStylePanel();
})();


var NL = String.fromCharCode(10);

// ===== 草稿 / 預覽 / 發布 =====

var draftState = { count: 0 };

function renderDraftBadge() {
  var badge = document.getElementById("pageDraft");
  if (!badge) return;
  badge.textContent = draftState.count ? ("草稿：" + draftState.count + " 處未發布") : "沒有未發布的草稿";
  badge.style.background = draftState.count ? "#fff3e6" : "";
  badge.style.color = draftState.count ? "#b45309" : "";
  var locked = typeof pageLock !== "undefined" && !pageLock.mine;
  document.getElementById("pagePublish").disabled = locked || (!draftState.count && !pageDirtyCount());
  document.getElementById("pageDraftDiscard").disabled = locked || !draftState.count;
}

async function loadDraftCount() {
  try {
    var d = await api("/api/admin/content/draft");
    draftState.count = d.count || 0;
  } catch (err) {
    draftState.count = 0;
  }
  renderDraftBadge();
}

async function saveDraftNow() {
  var data = await api("/api/admin/content/draft", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ changes: pageEditor.dirty })
  });
  pageEditor.dirty = {};
  draftState.count = data.count || 0;
  return data;
}

document.getElementById("pageSave").addEventListener("click", async function() {
  if (!pageDirtyCount()) return;
  var btn = this;
  btn.disabled = true;
  btn.textContent = "儲存中…";

  try {
    var data = await saveDraftNow();
    flash((data.message || "草稿已儲存。") + "按「預覽草稿」確認後，再按「發布上線」。");
    loadPageFrame();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.textContent = "儲存草稿";
    updatePageToolbar();
  }
});

document.getElementById("pagePreview").addEventListener("click", async function() {
  if (pageDirtyCount()) {
    if (!confirm("有尚未儲存的修改，要先存成草稿再預覽嗎？")) return;
    try {
      await saveDraftNow();
      loadPageFrame();
    } catch (err) {
      flash(err.message, false);
      return;
    }
  }
  window.open("/?cms-preview=1&t=" + Date.now(), "_blank");
});

document.getElementById("pagePublish").addEventListener("click", async function() {
  var btn = this;
  if (pageDirtyCount()) {
    if (!confirm("有尚未儲存的修改，會先存成草稿再一起發布。繼續？")) return;
    try {
      await saveDraftNow();
    } catch (err) {
      flash(err.message, false);
      return;
    }
  }
  if (!draftState.count) {
    flash("目前沒有草稿可以發布。", false);
    loadPageFrame();
    return;
  }
  var note = prompt("發布上線：共 " + draftState.count + " 處修改。" + NL + "請輸入這次修改的說明（選填，例如：更新服務項目）", "");
  if (note === null) {
    loadPageFrame();
    return;
  }

  btn.disabled = true;
  btn.textContent = "發布中…";
  try {
    var data = await api("/api/admin/content/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: note })
    });
    flash(data.message || "已發布上線。");
    await load();
    loadPageFrame();
    if (document.getElementById("historyBody").style.display !== "none") loadHistory();
    if (document.getElementById("versionBody").style.display !== "none") loadVersions();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.textContent = "發布上線";
    loadDraftCount();
  }
});

document.getElementById("pageDraftDiscard").addEventListener("click", async function() {
  if (!confirm("捨棄所有尚未發布的草稿？（正式網站不受影響）")) return;
  try {
    await api("/api/admin/content/draft", { method: "DELETE" });
    flash("草稿已捨棄。");
    loadPageFrame();
  } catch (err) {
    flash(err.message, false);
  }
});


// ===== 版本與還原點 =====

var versionState = { items: [], current: null };

var VERSION_SOURCE_LABEL = { publish: "發布", restore: "還原", revert: "修改紀錄還原", edit: "儲存", baseline: "系統" };

document.getElementById("versionToggle").addEventListener("click", function() {
  var body = document.getElementById("versionBody");
  var open = body.style.display === "none";
  body.style.display = open ? "" : "none";
  this.textContent = open ? "收合版本" : "展開版本";
  if (open) loadVersions();
});

async function loadVersions() {
  try {
    var data = await api("/api/admin/content/versions");
    versionState.items = data.items || [];
    versionState.current = data.current_id;
    renderVersions();
  } catch (err) {
    flash(err.message, false);
  }
}

function renderVersions() {
  var isSuper = !!(state.me && state.me.is_super);
  var tbody = document.getElementById("versionRows");
  tbody.innerHTML = versionState.items.length ? "" : '<tr><td colspan="5" class="muted">尚無版本。</td></tr>';

  versionState.items.forEach(function(v) {
    var tr = document.createElement("tr");
    if (v.is_baseline) tr.style.background = "#fff8f0";
    var tags = "";
    if (v.is_baseline) tags += '<span class="badge" style="background:#FF7000;color:#fff">還原點</span> ';
    if (v.id === versionState.current) tags += '<span class="badge" style="background:#0A0AA3;color:#fff">目前上線</span> ';

    var actions = '<button class="btn ghost sm" type="button" data-ver-preview="' + v.id + '">預覽</button> ';
    if (!v.is_baseline || isSuper) {
      actions += '<button class="btn ' + (v.is_baseline ? "danger" : "ghost") + ' sm" type="button" data-ver-restore="' + v.id + '">還原到此版本</button> ';
    } else {
      actions += '<span class="muted" style="font-size:12px">只有系統管理員可還原</span> ';
    }
    if (isSuper && v.source !== "baseline") {
      actions += '<button class="btn ghost sm" type="button" data-ver-base="' + v.id + '">' + (v.is_baseline ? "取消還原點" : "設為還原點") + "</button>";
    }

    tr.innerHTML =
      "<td><strong>#" + v.id + "</strong></td>" +
      "<td>" + esc(v.source === "baseline" && v.created_by === "system" ? twTime(v.created_at) : twTime(v.created_at)) + "</td>" +
      "<td>" + esc(v.created_by === "system" ? "系統" : v.created_by) + "</td>" +
      "<td>" + tags + esc(v.note || "") + ' <span class="muted">（' + (VERSION_SOURCE_LABEL[v.source] || v.source) + "，" + v.item_count + " 項設定）</span></td>" +
      "<td>" + actions + "</td>";
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-ver-preview]").forEach(function(b) {
    b.onclick = function() { window.open("/?cms-version=" + b.getAttribute("data-ver-preview") + "&t=" + Date.now(), "_blank"); };
  });
  tbody.querySelectorAll("[data-ver-restore]").forEach(function(b) {
    b.onclick = function() { restoreVersionUi(Number(b.getAttribute("data-ver-restore"))); };
  });
  tbody.querySelectorAll("[data-ver-base]").forEach(function(b) {
    b.onclick = function() { toggleBaselineUi(Number(b.getAttribute("data-ver-base"))); };
  });
}

async function restoreVersionUi(id) {
  var v = versionState.items.find(function(x) { return x.id === id; });
  if (!v) return;
  var msg = "將正式網站還原到" + (v.is_baseline ? "還原點" : "版本") + " #" + id + (v.note ? "（" + v.note + "）" : "") + "？" + NL + NL + "" +
    "・會立即上線" + NL + "・目前的內容會先自動存成一個版本，之後可以再還原回來";
  if (draftState.count) msg += NL + "・注意：還有 " + draftState.count + " 處草稿尚未發布，草稿不會被清除，之後發布會蓋過還原的內容";
  if (!confirm(msg)) return;
  if (v.is_baseline && !confirm("再次確認：還原點會把網站改回當時的樣子，確定要還原？")) return;

  try {
    var data = await api("/api/admin/content/versions/" + id + "/restore", { method: "POST" });
    flash(data.message || "已還原。");
    await load();
    loadPageFrame();
    loadVersions();
    if (document.getElementById("historyBody").style.display !== "none") loadHistory();
  } catch (err) {
    flash(err.message, false);
  }
}

async function toggleBaselineUi(id) {
  var v = versionState.items.find(function(x) { return x.id === id; });
  if (!v) return;
  var body = { on: !v.is_baseline };
  if (!v.is_baseline) {
    var note = prompt("設為還原點（不會被自動刪除，只有系統管理員能還原）。" + NL + "還原點名稱：", v.note || "");
    if (note === null) return;
    body.note = note;
  } else if (!confirm("取消這個還原點？取消後它會變成一般版本，超過 50 個版本時會被自動刪除。")) {
    return;
  }
  try {
    var data = await api("/api/admin/content/versions/" + id + "/baseline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    flash(data.message);
    loadVersions();
  } catch (err) {
    flash(err.message, false);
  }
}


document.getElementById("pageDiscard").addEventListener("click", function() {
  if (pageDirtyCount() && !confirm("確定放棄所有未儲存的修改？")) return;
  loadPageFrame();
});

document.getElementById("pageRevertKey").addEventListener("click", function() {
  var key = pageEditor.selectedKey;
  if (!key) return;
  if (!confirm("將「" + key + "」還原為網站原始內容？（按儲存後生效）")) return;
  pageEditor.dirty[key] = null;
  updatePageToolbar();
  flash("已標記還原，按「儲存草稿」後再發布上線。");
});

window.addEventListener("beforeunload", function(e) {
  if (pageDirtyCount()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ===== 編輯鎖（同一時間只有一個人可以編輯頁面內容）=====

var pageLock = { mine: false, holder: null, lastActivity: Date.now(), timer: null, idleReleased: false };
var LOCK_IDLE_MS = 15 * 60 * 1000;

function markPageActivity() {
  pageLock.lastActivity = Date.now();
}

document.addEventListener("mousemove", markPageActivity, { passive: true });
document.addEventListener("keydown", markPageActivity);

function renderPageLock() {
  var bar = document.getElementById("pageLockBar");
  var cover = document.getElementById("pageLockCover");
  var isSuper = !!(state.me && state.me.is_super);
  var h = pageLock.holder;

  ["pageSave", "pagePublish", "pageDraftDiscard", "pageRevertKey"].forEach(function(id) {
    var b = document.getElementById(id);
    if (b && !pageLock.mine) b.disabled = true;
  });

  if (pageLock.mine) {
    bar.style.display = "none";
    cover.style.display = "none";
    return;
  }

  var who = h ? esc(h.name || h.email) + "（" + esc(h.email) + "）" : "";
  var text = pageLock.idleReleased
    ? "你閒置超過 15 分鐘，編輯權已自動釋放，讓其他人可以編輯。"
    : (h ? who + " 正在編輯頁面內容（最後活動 " + esc(twTime(h.heartbeat_at)) + "）。同一時間只能一個人編輯，你目前只能檢視。" : "正在取得編輯權…");

  bar.style.display = "";
  bar.innerHTML = text + ' <button class="btn ghost sm" type="button" id="lockRetry">' + (pageLock.idleReleased ? "繼續編輯" : "重新檢查") + "</button>" +
    (isSuper && h && !pageLock.idleReleased ? ' <button class="btn danger sm" type="button" id="lockForce">強制接手</button>' : "");
  cover.style.display = "";
  cover.innerHTML = '<div class="lock-cover-msg">' + text + "</div>";

  document.getElementById("lockRetry").onclick = function() {
    pageLock.idleReleased = false;
    markPageActivity();
    acquirePageLock(false);
  };
  var force = document.getElementById("lockForce");
  if (force) {
    force.onclick = function() {
      if (!confirm("強制接手編輯權？" + (h ? h.email : "") + " 尚未儲存的修改將無法儲存。")) return;
      acquirePageLock(true);
    };
  }
}

async function acquirePageLock(force) {
  try {
    var res = await fetch("/api/admin/content/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ force: !!force })
    });
    var data = await res.json().catch(function() { return {}; });
    var wasMine = pageLock.mine;
    pageLock.mine = res.ok && data.mine;
    pageLock.holder = data.holder || null;
    if (wasMine && !pageLock.mine) {
      flash("編輯權已被 " + (pageLock.holder ? pageLock.holder.email : "其他人") + " 接手，你尚未儲存的修改無法儲存。", false);
    }
  } catch (err) {
    console.warn("lock failed", err);
  }
  renderPageLock();
  updatePageToolbar();
}

function releasePageLock() {
  if (!pageLock.mine) return;
  pageLock.mine = false;
  try {
    fetch("/api/admin/content/lock/release", { method: "POST", keepalive: true, credentials: "same-origin" });
  } catch (e) {}
}

function startPageLockLoop() {
  if (pageLock.timer) return;
  pageLock.timer = setInterval(function() {
    var onPages = document.getElementById("pages").classList.contains("active");
    if (!onPages) return;
    if (pageLock.mine && Date.now() - pageLock.lastActivity > LOCK_IDLE_MS && !pageDirtyCount()) {
      releasePageLock();
      pageLock.idleReleased = true;
      pageLock.holder = null;
      renderPageLock();
      updatePageToolbar();
      return;
    }
    if (!pageLock.idleReleased) acquirePageLock(false);
  }, 60 * 1000);
}

window.addEventListener("pagehide", releasePageLock);


document.querySelector('.nav button[data-target="pages"]').addEventListener("click", function() {
  if (!pageEditor.loaded) loadPageFrame();
  if (!pageLock.mine) {
    pageLock.idleReleased = false;
    markPageActivity();
    acquirePageLock(false);
  }
  startPageLockLoop();
});


// ===== 聯絡表單 =====

var contactState = { items: [], loadedOnce: false };

var CONTACT_LABEL = { "new": "新進件", "contacted": "已聯絡", "closed": "已結案", "spam": "垃圾訊息" };
var MAIL_LABEL = { "sent": "已寄出", "failed": "寄送失敗", "pending": "處理中" };

function twTime(v) {
  if (!v) return "";
  var d = new Date(String(v).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return v;
  return d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
}

function contactQuery() {
  var p = new URLSearchParams();
  var st = document.getElementById("contactStatus").value;
  var q = document.getElementById("contactQ").value.trim();
  if (st) p.set("status", st);
  if (q) p.set("q", q);
  return p;
}

async function loadContacts(append) {
  var p = contactQuery();
  if (append && contactState.items.length) {
    p.set("before_id", contactState.items[contactState.items.length - 1].id);
  }

  try {
    var data = await api("/api/admin/contacts?" + p.toString());
    contactState.items = append ? contactState.items.concat(data.items) : data.items;
    contactState.loadedOnce = true;

    var c = data.counts || {};
    document.getElementById("contactSummary").innerHTML =
      "新進件 <strong>" + (c["new"] || 0) + "</strong>｜已聯絡 " + (c.contacted || 0) +
      "｜已結案 " + (c.closed || 0) + "｜垃圾訊息 " + (c.spam || 0) +
      (data.mail_failed ? '｜<span style="color:#a22;font-weight:800">通知信寄送失敗 ' + data.mail_failed + " 筆</span>" : "") +
      "｜資料保存 " + data.retention_days + " 天後自動刪除";

    document.getElementById("contactExport").href = "/api/admin/contacts/export.csv?" + contactQuery().toString();
    document.getElementById("contactMore").style.display = data.has_more ? "" : "none";
    renderContacts();
  } catch (err) {
    flash(err.message, false);
  }
}

function renderContacts() {
  var tbody = document.getElementById("contactRows");
  tbody.innerHTML = "";

  if (!contactState.items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">沒有符合的資料。</td></tr>';
    return;
  }

  contactState.items.forEach(function(r) {
    var tr = document.createElement("tr");
    tr.innerHTML =
      "<td>" + esc(twTime(r.created_at)) + "</td>" +
      "<td><strong>" + esc(r.name) + '</strong><div class="muted">' + esc(r.phone) + "</div></td>" +
      "<td>" + esc(r.address) + "</td>" +
      "<td>" + esc(r.type) + "</td>" +
      '<td><span class="badge">' + esc(CONTACT_LABEL[r.status] || r.status) + "</span></td>" +
      "<td" + (r.mail_status === "failed" ? ' style="color:#a22;font-weight:800"' : "") + ">" + esc(MAIL_LABEL[r.mail_status] || r.mail_status) + "</td>" +
      '<td><button class="btn ghost" type="button" data-open-contact="' + r.id + '">查看</button></td>';
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-open-contact]").forEach(function(btn) {
    btn.onclick = function() { toggleContact(btn, Number(btn.dataset.openContact)); };
  });
}

function toggleContact(btn, id) {
  var row = btn.closest("tr");
  var next = row.nextElementSibling;
  if (next && next.dataset.detailFor === String(id)) {
    next.remove();
    return;
  }

  var r = contactState.items.find(function(x) { return x.id === id; });
  if (!r) return;

  var d = document.createElement("tr");
  d.dataset.detailFor = String(id);

  var opts = Object.keys(CONTACT_LABEL).map(function(k) {
    return '<option value="' + k + '"' + (r.status === k ? " selected" : "") + ">" + CONTACT_LABEL[k] + "</option>";
  }).join("");

  d.innerHTML =
    '<td colspan="7" style="background:#f8f8fc">' +
      '<div class="grid2">' +
        "<div><label>縣市 / 地址</label><div>" + esc(r.city) + " " + esc(r.address) + "</div></div>" +
        "<div><label>屋齡</label><div>" + esc(r.age || "未填寫") + "</div></div>" +
        "<div><label>地主 / 住戶概況</label><div>" + esc(r.owners || "未填寫") + "</div></div>" +
        '<div><label>電話</label><div><a href="tel:' + escAttr(r.phone) + '">' + esc(r.phone) + "</a></div></div>" +
        '<div class="field full"><label>其他說明</label><div style="white-space:pre-line">' + esc(r.message || "未填寫") + "</div></div>" +
        (r.mail_error ? '<div class="field full"><label>通知信錯誤</label><div class="muted">' + esc(r.mail_error) + "</div></div>" : "") +
        '<div class="field"><label>處理狀態</label><select data-c-status>' + opts + "</select></div>" +
        '<div class="field"><label>最後處理</label><div class="muted">' + esc(r.handled_by || "—") + " " + esc(twTime(r.handled_at)) + "</div></div>" +
        '<div class="field full"><label>備註</label><textarea data-c-note maxlength="1000">' + esc(r.note || "") + "</textarea></div>" +
      "</div>" +
      '<div class="actions">' +
        '<button class="btn primary" type="button" data-c-save>儲存</button>' +
        '<button class="btn danger" type="button" data-c-delete>刪除此筆</button>' +
      "</div>" +
    "</td>";

  row.after(d);

  d.querySelector("[data-c-save]").onclick = async function() {
    try {
      await api("/api/admin/contacts/" + id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: d.querySelector("[data-c-status]").value,
          note: d.querySelector("[data-c-note]").value
        })
      });
      flash("已更新。");
      loadContacts(false);
    } catch (err) {
      flash(err.message, false);
    }
  };

  d.querySelector("[data-c-delete]").onclick = async function() {
    if (!confirm("確定刪除這筆聯絡資料？刪除後無法復原（只能從備份找回）。")) return;
    try {
      await api("/api/admin/contacts/" + id, { method: "DELETE" });
      flash("已刪除。");
      loadContacts(false);
    } catch (err) {
      flash(err.message, false);
    }
  };
}

document.getElementById("contactSearch").addEventListener("click", function() { loadContacts(false); });
document.getElementById("contactStatus").addEventListener("change", function() { loadContacts(false); });
document.getElementById("contactQ").addEventListener("keydown", function(e) {
  if (e.key === "Enter") loadContacts(false);
});
document.getElementById("contactMore").addEventListener("click", function() { loadContacts(true); });
document.querySelector('.nav button[data-target="contacts"]').addEventListener("click", function() {
  loadContacts(false);
});


// ===== 系統備份 =====

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

async function loadBackups() {
  try {
    var data = await api("/api/admin/backups");
    var last = data.last_run;

    var html = "<div>備份檔案：" + data.files.count + " 個，共 " + fmtBytes(data.files.bytes) + "</div>";
    if (last) {
      html +=
        "<div>上次執行：" + esc(new Date(last.at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })) +
        "（" + esc(last.by === "cron" ? "自動排程" : last.by) + "）</div>" +
        (last.d1 ? "<div>資料庫：" + last.d1.tables + " 張表、" + last.d1.rows + " 筆資料</div>" : "") +
        (last.files ? "<div>檔案：本次複製 " + last.files.copied + "、已存在 " + last.files.skipped +
          (last.files.pending ? "、待下次複製 " + last.files.pending : "") + "</div>" : "") +
        "<div>清理過期表單紀錄：" + last.purged_contacts + " 筆</div>" +
        (last.health
          ? (last.health.issues.length
              ? '<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#fff0f0;color:#912020"><strong>健康檢查發現 ' + last.health.issues.length + " 項異常" +
                (last.health.alert ? "（通知信：" + esc(last.health.alert) + "）" : "") + "</strong><ul style=" + '"margin:6px 0 0;padding-left:20px"' + ">" +
                last.health.issues.map(function(i) { return "<li>" + esc(i) + "</li>"; }).join("") + "</ul></div>"
              : '<div style="margin-top:10px;color:#185b2a;font-weight:800">✓ 健康檢查：官網、投資人資料、聯絡表單服務皆正常</div>') +
            (typeof last.health.checks.entra_secret_days_left === "number"
              ? '<div class="muted">Entra 寄信密鑰剩餘 ' + last.health.checks.entra_secret_days_left + " 天</div>"
              : '<div class="muted">Entra 寄信密鑰到期日：尚未設定</div>')
          : "") +
        (last.errors && last.errors.length
          ? '<div style="color:#a22;font-weight:800">錯誤：' + esc(last.errors.join("；")) + "</div>"
          : '<div style="color:#185b2a;font-weight:800">✓ 最近一次備份成功</div>');
    } else {
      html += '<div class="muted">尚未執行過備份。</div>';
    }
    document.getElementById("backupSummary").innerHTML = html;

    var tbody = document.getElementById("backupRows");
    tbody.innerHTML = data.snapshots.length ? "" : '<tr><td colspan="4" class="muted">尚無快照。</td></tr>';
    data.snapshots.forEach(function(s) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(s.key.slice(3)) + "</td>" +
        "<td>" + fmtBytes(s.size) + "</td>" +
        "<td>" + esc(new Date(s.uploaded).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })) + "</td>" +
        '<td><a class="btn ghost" style="text-decoration:none" href="/api/admin/backups/download?key=' + encodeURIComponent(s.key) + '">下載</a></td>';
      tbody.appendChild(tr);
    });
  } catch (err) {
    flash(err.message, false);
  }
}

document.getElementById("backupRun").addEventListener("click", async function() {
  var btn = this;
  btn.disabled = true;
  btn.textContent = "備份中…";
  try {
    var data = await api("/api/admin/backups/run", { method: "POST" });
    var r = data.result;
    flash(r.errors.length ? "備份完成，但有錯誤：" + r.errors.join("；") : "備份完成。", !r.errors.length);
    await loadBackups();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.disabled = false;
    btn.textContent = "立即備份";
  }
});

document.getElementById("backupRefresh").addEventListener("click", loadBackups);

document.getElementById("alertTest").addEventListener("click", async function() {
  try {
    var data = await api("/api/admin/backups/test-alert", { method: "POST" });
    flash(data.message);
  } catch (err) {
    flash(err.message, false);
  }
});
document.querySelector('.nav button[data-target="backups"]').addEventListener("click", loadBackups);


// ===== SEO 與分享預覽 =====

var SEO_LIMIT = { "seo.title": 60, "seo.description": 160, "seo.og-title": 60, "seo.og-description": 160 };
var seoState = { defaults: {}, image: "" };

document.getElementById("seoToggle").addEventListener("click", function() {
  var body = document.getElementById("seoBody");
  var open = body.style.display === "none";
  body.style.display = open ? "" : "none";
  this.textContent = open ? "收合設定" : "展開設定";
});

function seoMeta(doc, selector) {
  var el = doc.querySelector(selector);
  return el ? (el.getAttribute("content") || "") : "";
}

// iframe 載入後，從實際渲染出來的首頁讀取目前的 SEO 值
function fillSeoForm(doc) {
  var keys = state.content_keys || [];
  var title = doc.title || "";
  var desc = seoMeta(doc, 'meta[name="description"]');
  var ogTitle = seoMeta(doc, 'meta[property="og:title"]');
  var ogDesc = seoMeta(doc, 'meta[property="og:description"]');

  seoState.image = seoMeta(doc, 'meta[property="og:image"]');

  setSeoField("seo.title", title);
  setSeoField("seo.description", desc);
  setSeoField("seo.og-title", keys.indexOf("seo.og-title") >= 0 ? ogTitle : "");
  setSeoField("seo.og-description", keys.indexOf("seo.og-description") >= 0 ? ogDesc : "");

  document.getElementById("seoImageHint").textContent =
    keys.indexOf("seo.og-image") >= 0 ? "目前使用：自訂分享圖片" : "目前使用：預設分享圖（Logo + 標語）";

  updateSeoPreview();
}

function setSeoField(key, value) {
  var el = document.querySelector('[data-seo-field="' + key + '"]');
  el.value = value;
  el.dataset.original = value;
}

function seoVal(key) {
  return document.querySelector('[data-seo-field="' + key + '"]').value.trim();
}

function updateSeoPreview() {
  var title = seoVal("seo.og-title") || seoVal("seo.title");
  var desc = seoVal("seo.og-description") || seoVal("seo.description");

  document.getElementById("seoPreviewTitle").textContent = title;
  document.getElementById("seoPreviewDesc").textContent = desc;
  document.getElementById("seoGoogleTitle").textContent = seoVal("seo.title");
  document.getElementById("seoGoogleDesc").textContent = seoVal("seo.description");
  document.getElementById("seoPreviewImg").style.backgroundImage =
    seoState.image ? "url(" + JSON.stringify(seoState.image) + ")" : "none";

  Object.keys(SEO_LIMIT).forEach(function(k) {
    var n = seoVal(k).length;
    var span = document.querySelector('[data-seo-count="' + k + '"]');
    span.textContent = "　" + n + " / 建議 " + SEO_LIMIT[k] + " 字內";
    span.style.color = n > SEO_LIMIT[k] ? "#a22" : "";
  });
}

document.querySelectorAll("[data-seo-field]").forEach(function(el) {
  el.addEventListener("input", function() {
    var key = el.dataset.seoField;
    var v = el.value.trim();
    var overridden = (state.content_keys || []).indexOf(key) >= 0;

    if (v === (el.dataset.original || "").trim()) {
      delete pageEditor.dirty[key];
    } else if (!v) {
      if (key === "seo.title" || key === "seo.description") {
        // 標題、描述不能空白：清空代表還原成網站原本的內容
        pageEditor.dirty[key] = overridden ? null : undefined;
        if (pageEditor.dirty[key] === undefined) delete pageEditor.dirty[key];
      } else {
        if (overridden) pageEditor.dirty[key] = null; else delete pageEditor.dirty[key];
      }
    } else {
      pageEditor.dirty[key] = { type: "plain", value: v };
    }

    updatePageToolbar();
    updateSeoPreview();
  });
});

document.getElementById("seoImageBtn").addEventListener("click", function() {
  pageEditor.imageTarget = { key: "seo.og-image", el: null, kind: "seo" };
  var input = document.getElementById("pageImageInput");
  input.value = "";
  input.click();
});

document.getElementById("seoImageReset").addEventListener("click", function() {
  if ((state.content_keys || []).indexOf("seo.og-image") < 0 && !pageEditor.dirty["seo.og-image"]) {
    flash("目前已經是預設圖片。");
    return;
  }
  pageEditor.dirty["seo.og-image"] = null;
  seoState.image = "";
  document.getElementById("seoImageHint").textContent = "儲存後將還原為預設圖片";
  updatePageToolbar();
  updateSeoPreview();
});


// ===== 修改紀錄（頁面內容）=====

var historyState = { batches: [] };

document.getElementById("historyToggle").addEventListener("click", function() {
  var body = document.getElementById("historyBody");
  var open = body.style.display === "none";
  body.style.display = open ? "" : "none";
  this.textContent = open ? "收合紀錄" : "展開紀錄";
  if (open) loadHistory();
});

function stripTags(v) {
  var d = document.createElement("div");
  d.innerHTML = v || "";
  return d.textContent || "";
}

function historyValue(type, value) {
  if (value === null || value === undefined) return '<span class="muted">（網站原始內容）</span>';
  if (type === "image") {
    return '<img src="' + escAttr(value) + '" style="max-width:160px;max-height:90px;border-radius:6px;border:1px solid var(--line)">';
  }
  if (type === "layout") {
    try {
      var l = JSON.parse(value);
      return esc("共 " + l.order.length + " 個，隱藏 " + l.hidden.length + " 個，複製 " + Object.keys(l.clones || {}).length + " 個");
    } catch (e) {
      return esc(value);
    }
  }
  if (type === "tstyle" || type === "bstyle") return '<code style="font-size:12px">' + esc(value) + "</code>";
  var t = stripTags(value);
  return esc(t.length > 120 ? t.slice(0, 120) + "…" : t);
}

function historyKeyLabel(key) {
  if (key === "seo.title") return "網頁標題";
  if (key === "seo.description") return "搜尋描述";
  if (key === "seo.og-title") return "分享標題";
  if (key === "seo.og-description") return "分享描述";
  if (key === "seo.og-image") return "分享圖片";
  if (key === "hero.bg") return "首頁大圖";
  if (key === "contact.bg") return "聯絡區背景";
  if (key === "header.img-01") return "Logo";
  if (key.indexOf("layout.") === 0) return "框框排列：" + (LIST_LABELS[key.slice(7)] || key.slice(7));
  if (key.indexOf("style.") === 0) return "文字樣式：" + key.slice(6);
  if (key.indexOf("bstyle.") === 0) return "框框樣式：" + key.slice(7);
  return key;
}

async function loadHistory() {
  try {
    var data = await api("/api/admin/content/history");
    historyState.batches = data.batches || [];
    renderHistory();
  } catch (err) {
    flash(err.message, false);
  }
}

function renderHistory() {
  var box = document.getElementById("historyList");
  if (!historyState.batches.length) {
    box.innerHTML = '<p class="muted">尚無修改紀錄。</p>';
    return;
  }

  box.innerHTML = historyState.batches.map(function(b, bi) {
    var rows = b.items.map(function(it) {
      return "<tr>" +
        "<td><strong>" + esc(historyKeyLabel(it.key)) + "</strong></td>" +
        "<td>" + historyValue(it.old_type, it.old_value) + "</td>" +
        "<td>" + historyValue(it.new_type, it.new_value) + "</td>" +
        '<td><button class="btn ghost" type="button" data-revert-item="' + bi + ":" + it.id + '">還原這項</button></td>' +
      "</tr>";
    }).join("");

    return '<details style="border:1px solid var(--line);border-radius:12px;padding:10px 14px;margin-bottom:10px">' +
      '<summary style="cursor:pointer;font-weight:800">' +
        esc(twTime(b.changed_at)) + "｜" + esc(b.changed_by) + "｜" +
        (b.source === "revert" ? "還原 " : "修改 ") + b.items.length + " 處" +
      "</summary>" +
      '<div class="table-wrap" style="margin-top:10px"><table>' +
        "<thead><tr><th style=" + '"width:140px"' + ">區塊</th><th>修改前</th><th>修改後</th><th style=" + '"width:110px"' + "></th></tr></thead>" +
        "<tbody>" + rows + "</tbody></table></div>" +
      '<div class="actions"><button class="btn danger" type="button" data-revert-batch="' + bi + '">還原這次的全部修改</button></div>' +
    "</details>";
  }).join("");

  box.querySelectorAll("[data-revert-batch]").forEach(function(btn) {
    btn.onclick = function() {
      var b = historyState.batches[Number(btn.dataset.revertBatch)];
      revertHistory(b.batch_id, 0, "將這次的 " + b.items.length + " 處修改全部改回修改前的內容？");
    };
  });

  box.querySelectorAll("[data-revert-item]").forEach(function(btn) {
    btn.onclick = function() {
      var parts = btn.dataset.revertItem.split(":");
      var b = historyState.batches[Number(parts[0])];
      revertHistory(b.batch_id, Number(parts[1]), "將這個區塊改回修改前的內容？");
    };
  });
}

async function revertHistory(batchId, itemId, question) {
  if (pageDirtyCount() && !confirm("目前有未儲存的修改，還原後會被捨棄。確定繼續？")) return;
  if (!confirm(question + "（會立即上線）")) return;

  try {
    var data = await api("/api/admin/content/revert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batch_id: batchId, item_id: itemId })
    });
    flash("已還原並上線。" + (data.message ? "（" + data.message + "）" : ""));
    await load();
    loadPageFrame();
    loadHistory();
  } catch (err) {
    flash(err.message, false);
  }
}


// ===== 操作紀錄 =====

var auditState = { items: [] };

var AUDIT_MODULE = [
  ["/api/admin/content/revert", "還原頁面內容"],
  ["/api/admin/content/image", "上傳頁面圖片"],
  ["/api/admin/content", "儲存頁面內容"],
  ["/api/admin/contacts", "聯絡表單"],
  ["/api/admin/company", "公司資料"],
  ["/api/admin/board", "董事會"],
  ["/api/admin/documents", "文件"],
  ["/api/admin/faqs", "常見問題"],
  ["/api/admin/users", "帳號權限"],
  ["/api/admin/backups/test-alert", "測試通知"],
  ["/api/admin/backups", "系統備份"]
];

function auditAction(r) {
  var label = r.path;
  for (var i = 0; i < AUDIT_MODULE.length; i++) {
    if (r.path.indexOf(AUDIT_MODULE[i][0]) === 0) { label = AUDIT_MODULE[i][1]; break; }
  }
  var verb = r.method === "POST" ? "新增" : r.method === "PUT" ? "修改" : r.method === "DELETE" ? "刪除" : r.method;
  if (label.indexOf("儲存") === 0 || label.indexOf("還原") === 0 || label.indexOf("上傳") === 0 || label.indexOf("測試") === 0) verb = "";
  if (label === "系統備份") verb = "立即執行";
  var id = r.path.split("/").pop();
  return (verb ? verb + " " : "") + label + (/^[0-9]+$/.test(id) ? " #" + id : "");
}

async function loadAudit(append) {
  var q = append && auditState.items.length ? "?before_id=" + auditState.items[auditState.items.length - 1].id : "";
  try {
    var data = await api("/api/admin/audit" + q);
    auditState.items = append ? auditState.items.concat(data.items) : data.items;
    document.getElementById("auditMore").style.display = data.has_more ? "" : "none";

    var tbody = document.getElementById("auditRows");
    tbody.innerHTML = auditState.items.length ? "" : '<tr><td colspan="4" class="muted">尚無紀錄。</td></tr>';
    auditState.items.forEach(function(r) {
      var tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + esc(twTime(r.at)) + "</td>" +
        "<td>" + esc(r.email) + "</td>" +
        "<td><strong>" + esc(auditAction(r)) + "</strong>" +
          (r.summary ? '<div class="muted" style="word-break:break-all;max-height:3.2em;overflow:hidden">' + esc(r.summary) + "</div>" : "") +
        "</td>" +
        "<td" + (r.status >= 400 ? ' style="color:#a22;font-weight:800"' : "") + ">" + (r.status < 400 ? "成功" : "失敗 " + r.status) + "</td>";
      tbody.appendChild(tr);
    });
  } catch (err) {
    flash(err.message, false);
  }
}

document.getElementById("auditMore").addEventListener("click", function() { loadAudit(true); });
document.querySelector('.nav button[data-target="audit"]').addEventListener("click", function() { loadAudit(false); });


// ===== 常見問題 =====

document
  .getElementById("faqForm")
  .addEventListener("submit", async function(e) {
    e.preventDefault();

    var body = Object.fromEntries(new FormData(e.target).entries());
    body.is_public = body.is_public === "true";

    try {
      await api("/api/admin/faqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      e.target.reset();
      flash("常見問題已新增。");
      await load();
    } catch (err) {
      flash(err.message, false);
    }
  });


function renderFaqs() {
  var tbody = document.getElementById("faqRows");
  tbody.innerHTML = "";

  var list = state.faqs || [];

  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted">尚無常見問題。</td></tr>';
    return;
  }

  list.forEach(function(f) {
    var tr = document.createElement("tr");
    tr.dataset.faqId = f.id;

    tr.innerHTML =
      '<td data-field="sort_order">' + esc(f.sort_order || 0) + '</td>' +
      '<td data-field="qa">' +
        '<strong>' + esc(f.question) + '</strong>' +
        '<div class="muted" style="margin-top:6px;white-space:pre-line">' + esc(f.answer) + '</div>' +
      '</td>' +
      '<td data-field="is_public"><span class="badge">' + (f.is_public ? "公開" : "隱藏") + '</span></td>' +
      '<td data-actions>' +
        '<button class="btn ghost" data-edit-faq="' + f.id + '">編輯</button> ' +
        '<button class="btn danger" data-delete-faq="' + f.id + '">刪除</button>' +
      '</td>';

    tbody.appendChild(tr);
  });

  tbody.querySelectorAll("[data-edit-faq]").forEach(function(btn) {
    btn.onclick = function() { startFaqEdit(Number(btn.dataset.editFaq)); };
  });

  tbody.querySelectorAll("[data-delete-faq]").forEach(function(btn) {
    btn.onclick = function() { removeFaq(Number(btn.dataset.deleteFaq)); };
  });
}


function startFaqEdit(id) {
  var f = (state.faqs || []).find(function(x) { return x.id === id; });
  if (!f) return;

  var tr = document.querySelector('tr[data-faq-id="' + id + '"]');
  if (!tr) return;

  tr.querySelector('[data-field="sort_order"]').innerHTML =
    '<input data-edit="sort_order" type="number" value="' + Number(f.sort_order || 0) + '" style="max-width:70px">';

  tr.querySelector('[data-field="qa"]').innerHTML =
    '<div style="display:grid;gap:8px">' +
      '<input data-edit="question" maxlength="200" value="' + escAttr(f.question || "") + '">' +
      '<textarea data-edit="answer" maxlength="2000" style="min-height:110px">' + esc(f.answer || "") + '</textarea>' +
    '</div>';

  tr.querySelector('[data-field="is_public"]').innerHTML =
    '<select data-edit="is_public">' +
      '<option value="true"' + (f.is_public ? " selected" : "") + '>公開</option>' +
      '<option value="false"' + (!f.is_public ? " selected" : "") + '>隱藏</option>' +
    '</select>';

  tr.querySelector("[data-actions]").innerHTML =
    '<button class="btn primary" data-save-faq="' + id + '">儲存</button> ' +
    '<button class="btn ghost" data-cancel-faq="' + id + '">取消</button>';

  tr.querySelector("[data-save-faq]").onclick = function() { saveFaqInline(id); };
  tr.querySelector("[data-cancel-faq]").onclick = function() { renderFaqs(); };
}


async function saveFaqInline(id) {
  var tr = document.querySelector('tr[data-faq-id="' + id + '"]');
  if (!tr) return;

  var body = {
    question: tr.querySelector('[data-edit="question"]').value.trim(),
    answer: tr.querySelector('[data-edit="answer"]').value.trim(),
    sort_order: Number(tr.querySelector('[data-edit="sort_order"]').value) || 0,
    is_public: tr.querySelector('[data-edit="is_public"]').value === "true"
  };

  if (!body.question || !body.answer) {
    flash("問題與回答不可空白。", false);
    return;
  }

  var saveBtn = tr.querySelector("[data-save-faq]");
  saveBtn.disabled = true;
  saveBtn.textContent = "儲存中…";

  try {
    await api("/api/admin/faqs/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    flash("常見問題已更新。");
    await load();
  } catch (err) {
    flash(err.message, false);
    saveBtn.disabled = false;
    saveBtn.textContent = "儲存";
  }
}


async function removeFaq(id) {
  if (!confirm("確定刪除這則常見問題？")) return;

  try {
    await api("/api/admin/faqs/" + id, { method: "DELETE" });
    flash("常見問題已刪除。");
    await load();
  } catch (err) {
    flash(err.message, false);
  }
}


function esc(v) {

  return String(
    v == null
      ? ""
      : v
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      "\\\"",
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
}


load()
  .catch(
    function(err) {

      flash(
        err.message,
        false
      );
    }
  );

</script>

</body>

</html>`;
}
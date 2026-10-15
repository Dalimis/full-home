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

    try {
      if (path === "/admin" || path === "/admin/") {
        return htmlResponse(adminHtml());
      }

      // 首頁：把後台編輯過的文字/圖片套進 HTML（HTMLRewriter，搜尋引擎也看得到）
      if (path === "/" && request.method === "GET") {
        ctx?.passThroughOnException?.();
        return renderHomepage(request, env);
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

      if (path === "/api/admin/backups/download" && request.method === "GET") {
        return downloadBackup(url, env);
      }

      // ===== 頁面內容 =====
      if (path === "/api/admin/content" && request.method === "PUT") {
        return saveSiteContent(request, env, me);
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
    file.stream(),
    {
      httpMetadata: {
        contentType: mimeType
      },

      customMetadata: {
        originalName
      }
    }
  );

  const result =
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


  if (doc?.file_key) {

    await env.FILES.delete(
      doc.file_key
    );
  }


  await env.DB.prepare(
    `
    DELETE FROM documents
    WHERE id = ?
    `
  )
    .bind(id)
    .run();


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


  headers.set(
    "Cache-Control",
    "public, max-age=3600"
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

  if (!env.BACKUPS) {
    result.errors.push("BACKUPS bucket not bound");
  } else {
    try { result.d1 = await backupD1(env); } catch (e) { result.errors.push("d1: " + e.message); }
    try { result.files = await backupFiles(env); } catch (e) { result.errors.push("files: " + e.message); }
    await env.BACKUPS.put("status/last-run.json", JSON.stringify(result, null, 2), {
      httpMetadata: { contentType: "application/json" }
    });
  }

  console.log("maintenance", JSON.stringify(result));
  return result;
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
  await ensureSiteContentTable(env);
  const body = await request.json();
  const changes = body && typeof body.changes === "object" ? body.changes : {};
  const keys = Object.keys(changes);

  if (!keys.length) return json({ ok: false, message: "沒有需要儲存的修改。" }, 400);
  if (keys.length > 300) return json({ ok: false, message: "一次修改太多項目。" }, 400);

  const stmts = [];

  for (const key of keys) {
    if (!CONTENT_KEY_RE.test(key) || key.length > 60) {
      return json({ ok: false, message: `欄位代碼不正確：${key}` }, 400);
    }

    const c = changes[key];

    if (c === null) {
      stmts.push(env.DB.prepare("DELETE FROM site_content WHERE key = ?").bind(key));
      continue;
    }

    let type, value;

    if (c.type === "text") {
      type = "text";
      value = sanitizeInlineHtml(c.value);
      if (!value) return json({ ok: false, message: `「${key}」不可空白；要恢復原文請用「還原預設」。` }, 400);
    } else if (c.type === "image") {
      type = "image";
      value = String(c.value || "");
      if (!MEDIA_URL_RE.test(value)) return json({ ok: false, message: "圖片網址不正確。" }, 400);
    } else {
      return json({ ok: false, message: "內容類型不正確。" }, 400);
    }

    stmts.push(env.DB.prepare(`
      INSERT INTO site_content (key, type, value, updated_at, updated_by)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
      ON CONFLICT(key) DO UPDATE SET
        type = excluded.type, value = excluded.value,
        updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by
    `).bind(key, type, value, me.email));
  }

  await env.DB.batch(stmts);
  console.log("site content saved", me.email, keys.join(","));
  return json({ ok: true, message: `已儲存 ${keys.length} 處修改。` });
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

async function renderHomepage(request, env) {
  // 不帶快取條件去拿原始 HTML，避免 304 讓瀏覽器沿用舊內容
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  headers.delete("If-Modified-Since");
  const origin = await fetch(new Request(request.url, { method: "GET", headers, redirect: "manual" }));

  const ct = origin.headers.get("content-type") || "";
  if (origin.status !== 200 || !ct.includes("text/html")) return origin;

  let content;
  try {
    content = await loadSiteContent(env);
  } catch (error) {
    console.error("load site content failed:", error);
    return origin;
  }

  const get = (el, attr, type) => {
    const c = content.get(el.getAttribute(attr));
    return c && c.type === type ? c.value : null;
  };

  const rewritten = new HTMLRewriter()
    .on("[data-edit]", {
      element(el) {
        const v = get(el, "data-edit", "text");
        if (v !== null) el.setInnerContent(v, { html: true });
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
    .transform(origin);

  const out = new Response(rewritten.body, rewritten);
  out.headers.delete("ETag");
  out.headers.delete("Last-Modified");
  out.headers.set("Cache-Control", "no-cache");
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

  .grid2,
  .count-grid{
    grid-template-columns:
      1fr;
  }
}

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

      <h2>
        上傳文件
      </h2>

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

          <label>
            標題
          </label>

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

          <label>
            檔案
          </label>

          <input
            name="file"
            type="file"
            required
            accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp"
          >

        </div>


        <div class="field full">

          <button
            class="btn orange"
            type="submit"
          >
            上傳並發布
          </button>

        </div>

      </form>

    </div>


    <div class="panel">

      <h2>
        文件列表
      </h2>

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

    <div class="panel" style="padding:16px 20px">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <strong style="color:var(--blue)">首頁內容編輯</strong>
        <span class="muted">點文字直接修改；點 Logo 或「更換背景圖」上傳新圖片。改完按「儲存」才會上線。</span>
        <span style="flex:1"></span>
        <span id="pageDirty" class="badge">尚無修改</span>
        <button class="btn ghost" type="button" id="pageRevertKey" disabled>還原此區塊預設</button>
        <button class="btn ghost" type="button" id="pageDiscard">放棄修改</button>
        <button class="btn primary" type="button" id="pageSave">儲存並上線</button>
      </div>
      <div id="pageSelected" class="muted" style="margin-top:8px">尚未選取區塊</div>
      <input type="file" id="pageImageInput" accept="image/jpeg,image/png,image/webp" style="display:none">
    </div>

    <div class="panel" style="padding:0;overflow:hidden">
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
      <h2>系統備份</h2>
      <p class="muted" style="margin-top:-8px">
        每天凌晨 2 點自動備份：資料庫完整快照（保留最近 30 份）、上傳檔案增量複製到獨立的備份空間。
        來源檔案被刪除時，備份不會跟著刪除。
      </p>
      <div id="backupSummary" style="margin:12px 0"></div>
      <div class="actions">
        <button class="btn primary" type="button" id="backupRun">立即備份</button>
        <button class="btn ghost" type="button" id="backupRefresh">重新整理</button>
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


document
  .getElementById(
    "docForm"
  )
  .addEventListener(
    "submit",
    async function(e) {

      e.preventDefault();


      var btn =
        e.target.querySelector(
          "button[type=submit]"
        );


      try {

        btn.disabled =
          true;


        btn.textContent =
          "上傳中…";


        await api(
          "/api/admin/documents",
          {
            method: "POST",

            body:
              new FormData(
                e.target
              )
          }
        );


        e.target.reset();


        flash(
          "文件已上傳。"
        );


        await load();

      } catch (err) {

        flash(
          err.message,
          false
        );

      } finally {

        btn.disabled =
          false;


        btn.textContent =
          "上傳並發布";
      }
    }
  );


function renderDocs() {

  var tbody =
    document.getElementById(
      "docRows"
    );


  tbody.innerHTML =
    "";


  (
    state.documents ||
    []
  )
    .forEach(
      function(d) {

        var tr =
          document.createElement(
            "tr"
          );


        var fileLink =
          d.is_public
            ? (
              "<a href=\\\"/files/" +
              d.id +
              "\\\" target=\\\"_blank\\\">查看檔案</a>"
            )
            : (
              "<span class=\\\"muted\\\">隱藏文件</span>"
            );


        tr.innerHTML =
          "<td>" +
          esc(
            d.category
          ) +

          "<br><span class=\\\"muted\\\">" +
          esc(
            d.subcategory ||
            ""
          ) +
          "</span></td>" +

          "<td>" +
          esc(
            (
              d.year ||
              ""
            ) +
            " " +
            (
              d.quarter ||
              ""
            )
          ) +
          "</td>" +

          "<td><strong>" +
          esc(
            d.title
          ) +
          "</strong></td>" +

          "<td>" +
          fileLink +
          "</td>" +

          "<td><span class=\\\"badge\\\">" +
          (
            d.is_public
              ? "公開"
              : "隱藏"
          ) +
          "</span></td>" +

          "<td>" +

          "<button class=\\\"btn ghost\\\" data-edit-doc=\\\"" +
          d.id +
          "\\\">編輯</button> " +

          "<button class=\\\"btn danger\\\" data-delete-doc=\\\"" +
          d.id +
          "\\\">刪除</button>" +

          "</td>";


        tbody.appendChild(
          tr
        );
      }
    );


  tbody
    .querySelectorAll(
      "[data-edit-doc]"
    )
    .forEach(
      function(btn) {

        btn.onclick =
          function() {

            editDoc(
              Number(
                btn.dataset.editDoc
              )
            );
          };
      }
    );


  tbody
    .querySelectorAll(
      "[data-delete-doc]"
    )
    .forEach(
      function(btn) {

        btn.onclick =
          function() {

            removeDoc(
              Number(
                btn.dataset.deleteDoc
              )
            );
          };
      }
    );
}


async function editDoc(
  id
) {

  var d =
    (
      state.documents ||
      []
    )
      .find(
        function(x) {
          return x.id === id;
        }
      );


  if (!d) {
    return;
  }


  var title =
    prompt(
      "標題",
      d.title
    );


  if (
    title === null
  ) {
    return;
  }


  var year =
    prompt(
      "年度",
      d.year ||
      ""
    );


  if (
    year === null
  ) {
    return;
  }


  var quarter =
    prompt(
      "季度",
      d.quarter ||
      ""
    );


  if (
    quarter === null
  ) {
    return;
  }


  var pub =
    confirm(
      "按「確定」設為公開；按「取消」設為隱藏。"
    );


  try {

    await api(
      "/api/admin/documents/" +
      id,
      {
        method:
          "PUT",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({

            category:
              d.category,

            subcategory:
              d.subcategory ||
              "",

            year:
              year,

            quarter:
              quarter,

            title:
              title,

            description:
              d.description ||
              "",

            sort_order:
              d.sort_order ||
              0,

            is_public:
              pub
          })
      }
    );


    flash(
      "文件資料已更新。"
    );


    await load();

  } catch (err) {

    flash(
      err.message,
      false
    );
  }
}


async function removeDoc(
  id
) {

  if (
    !confirm(
      "確定刪除此文件？R2 檔案也會一起刪除。"
    )
  ) {
    return;
  }


  try {

    await api(
      "/api/admin/documents/" +
      id,
      {
        method:
          "DELETE"
      }
    );


    flash(
      "文件已刪除。"
    );


    await load();

  } catch (err) {

    flash(
      err.message,
      false
    );
  }
}


// ===== 權限 =====

var SECTION_PERMISSION = {
  pages: "pages",
  contacts: "contacts",
  backups: "users",
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
    ".cms-bg-btn{position:absolute;top:84px;right:16px;z-index:50;background:#FF7000;color:#fff;border:0;border-radius:8px;padding:8px 12px;font-weight:800;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.25)}";
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
    if (!el) return;
    e.preventDefault();
    activatePageText(el);
  }, true);

  doc.addEventListener("submit", function(e) { e.preventDefault(); }, true);
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
      pageEditor.dirty[el.getAttribute("data-edit")] = { type: "text", value: el.innerHTML };
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

  if (file.size > 5 * 1024 * 1024) {
    flash("圖片上限為 5 MB。", false);
    return;
  }

  var fd = new FormData();
  fd.append("file", file);

  try {
    flash("圖片上傳中…");
    var data = await api("/api/admin/content/image", { method: "POST", body: fd });

    if (t.kind === "img") {
      t.el.setAttribute("src", data.url);
    } else {
      t.el.style.setProperty("--edit-bg", "url(" + JSON.stringify(data.url) + ")");
    }

    pageEditor.dirty[t.key] = { type: "image", value: data.url };
    updatePageToolbar();
    flash("圖片已上傳，按「儲存並上線」後生效。");
  } catch (err) {
    flash(err.message, false);
  }
});

document.getElementById("pageSave").addEventListener("click", async function() {
  if (!pageDirtyCount()) return;
  var btn = this;
  btn.disabled = true;
  btn.textContent = "儲存中…";

  try {
    var data = await api("/api/admin/content", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ changes: pageEditor.dirty })
    });
    flash(data.message || "已儲存。");
    await load();
    loadPageFrame();
  } catch (err) {
    flash(err.message, false);
  } finally {
    btn.textContent = "儲存並上線";
    updatePageToolbar();
  }
});

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
  flash("已標記還原，按「儲存並上線」後生效。");
});

window.addEventListener("beforeunload", function(e) {
  if (pageDirtyCount()) {
    e.preventDefault();
    e.returnValue = "";
  }
});

document.querySelector('.nav button[data-target="pages"]').addEventListener("click", function() {
  if (!pageEditor.loaded) loadPageFrame();
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
document.querySelector('.nav button[data-target="backups"]').addEventListener("click", loadBackups);


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
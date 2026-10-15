export default {
  async fetch(request, env) {
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
    try {
      if (path === "/admin" || path === "/admin/") {
        return htmlResponse(adminHtml());
      }

      if (path === "/api/public/investors" && request.method === "GET") {
        return publicInvestors(env);
      }

      if (path.startsWith("/files/") && request.method === "GET") {
        return servePublicFile(path, env);
      }

      if (path === "/api/admin/bootstrap" && request.method === "GET") {
        return adminBootstrap(env);
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
      )
  });
}


async function adminBootstrap(env) {

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
      documents.results || []
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
        contentType:
          file.type ||
          "application/octet-stream"
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
        file.type ||
          "application/octet-stream",

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

  </div>

</aside>


<main>

  <div class="top">

    <h1>
      網站管理後台
    </h1>

    <a
      href="/"
      target="_blank"
    >
      開啟官網 ↗
    </a>

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
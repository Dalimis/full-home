export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/contact") {
      return json({ ok: false, message: "Not found" }, 404);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "https://full-home.com.tw",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (request.method !== "POST") {
      return json({ ok: false, message: "Method not allowed" }, 405);
    }

    try {
      const contentType = request.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        return json(
          { ok: false, message: "Invalid content type" },
          415
        );
      }

      const body = await request.json();

      // Honeypot 防簡易機器人
      if (String(body.website || "").trim()) {
        return json({ ok: true });
      }

      const name = clean(body.name, 80);

      const phone = normalizeTaiwanPhone(
        clean(body.phone, 50)
      );

      const city = clean(body.city, 20);

      const rawAddress = clean(
        body.address,
        220
      );

      // 避免前端已經加入縣市時再次重複
      const address = rawAddress.startsWith(city)
        ? rawAddress
        : `${city}${rawAddress}`;

      const age = clean(body.age, 50);

      const owners = clean(
        body.owners,
        120
      );

      const type =
        clean(body.type, 80) ||
        "尚不確定";

      const message = clean(
        body.message,
        2000
      );

      const allowedCities = new Set([
        "臺北市",
        "新北市",
        "桃園市",
        "臺中市",
        "臺南市",
        "高雄市",
        "基隆市",
        "新竹市",
        "嘉義市",
        "新竹縣",
        "苗栗縣",
        "彰化縣",
        "南投縣",
        "雲林縣",
        "嘉義縣",
        "屏東縣",
        "宜蘭縣",
        "花蓮縣",
        "臺東縣",
        "澎湖縣",
        "金門縣",
        "連江縣"
      ]);

      if (
        !name ||
        !phone ||
        !city ||
        !rawAddress
      ) {
        return json(
          {
            ok: false,
            message:
              "請完整填寫姓名、聯絡電話、基地縣市與詳細地址。"
          },
          400
        );
      }

      if (!allowedCities.has(city)) {
        return json(
          {
            ok: false,
            message:
              "基地縣市格式不正確。"
          },
          400
        );
      }

      if (!isValidTaiwanPhone(phone)) {
        return json(
          {
            ok: false,
            message:
              "聯絡電話格式不正確，請輸入有效的台灣手機或市話。"
          },
          400
        );
      }

      if (
        !env.TENANT_ID ||
        !env.CLIENT_ID ||
        !env.CLIENT_SECRET ||
        !env.MAIL_FROM
      ) {
        console.error(
          "Missing Worker environment variables."
        );

        return json(
          {
            ok: false,
            message:
              "系統寄信設定尚未完成。"
          },
          500
        );
      }

      /*
       * Microsoft Entra
       * 取得 Graph Access Token
       */
      const tokenResponse =
        await fetch(
          `https://login.microsoftonline.com/${encodeURIComponent(
            env.TENANT_ID
          )}/oauth2/v2.0/token`,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded"
            },
            body:
              new URLSearchParams({
                client_id:
                  env.CLIENT_ID,

                client_secret:
                  env.CLIENT_SECRET,

                scope:
                  "https://graph.microsoft.com/.default",

                grant_type:
                  "client_credentials"
              })
          }
        );

      const tokenData =
        await tokenResponse.json();

      if (
        !tokenResponse.ok ||
        !tokenData.access_token
      ) {
        console.error(
          "Microsoft token error:",
          tokenResponse.status,
          tokenData
        );

        return json(
          {
            ok: false,
            message:
              "郵件服務驗證失敗。"
          },
          502
        );
      }

      /*
       * 台灣時間
       */
      const submittedAt =
        new Date().toLocaleString(
          "zh-TW",
          {
            timeZone:
              "Asia/Taipei",
            hour12: false
          }
        );

      const phoneRaw =
        phone.replace(/\D/g, "");

      const addressUrl =
        encodeURIComponent(address);

      /*
       * 郵件主旨
       */
      const subject =
        `【馥鴻建設官網諮詢】${name}｜${type}｜${address}`;

      /*
       * HTML Email
       */
      const htmlBody = `
<!DOCTYPE html>
<html lang="zh-Hant">
<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<meta
  name="color-scheme"
  content="light only"
>

<title>
新諮詢：${escapeHtml(name)}｜馥鴻建設
</title>

<style>

@media only screen and (max-width:620px){

  .container{
    width:100%!important;
  }

  .px{
    padding-left:20px!important;
    padding-right:20px!important;
  }

  .stack,
  .stack td{
    display:block!important;
    width:100%!important;
    box-sizing:border-box;
  }

  .label{
    padding-bottom:2px!important;
  }

  .btn{
    display:block!important;
    width:100%!important;
    margin:0 0 10px 0!important;
    box-sizing:border-box;
  }

  .h1{
    font-size:22px!important;
  }

}

</style>

</head>

<body
  style="
    margin:0;
    padding:0;
    background:#efeae0;
  "
>

<!-- Inbox Preview -->
<div
  style="
    display:none;
    max-height:0;
    overflow:hidden;
    mso-hide:all;
  "
>
${escapeHtml(name)}
 ·
${escapeHtml(phone)}
 ·
${escapeHtml(address)}
（${escapeHtml(type)}）
</div>


<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    background:#efeae0;
  "
>

<tr>

<td
  align="center"
  style="
    padding:32px 12px;
  "
>


<table
  role="presentation"
  class="container"
  width="600"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    width:600px;
    max-width:600px;
  "
>


<tr>

<td
  style="
    padding:0 4px 12px;
    font-family:
      'Microsoft JhengHei',
      'PingFang TC',
      Arial,
      sans-serif;
    font-size:12px;
    color:#5a6661;
    letter-spacing:1px;
  "
>

官網表單 · 免費初步評估 · 新案件通知

</td>

</tr>


<tr>

<td
  style="
    background:#ffffff;
    border-radius:6px;
  "
>


<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
>


<!-- HEADER -->

<tr>

<td
  class="px"
  bgcolor="#16352d"
  style="
    background:#16352d;
    padding:30px 36px 32px;
    border-radius:6px 6px 0 0;
  "
>

<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
>

<tr>

<td
  style="
    font-family:
      'PMingLiU',
      serif;
    font-size:20px;
    font-weight:bold;
    color:#ffffff;
    letter-spacing:3px;
  "
>

馥鴻建設

<br>

<span
  style="
    font-family:Arial,sans-serif;
    font-size:10px;
    font-weight:normal;
    color:#d9c49a;
    letter-spacing:3px;
  "
>

URBAN RENEWAL · REBUILDING

</span>

</td>


<td
  align="right"
  valign="middle"
>

<span
  style="
    display:inline-block;
    background:#d9c49a;
    color:#16352d;
    font-family:
      'Microsoft JhengHei',
      sans-serif;
    font-size:12px;
    font-weight:bold;
    padding:5px 12px;
    border-radius:999px;
  "
>

新諮詢

</span>

</td>

</tr>


<tr>

<td
  colspan="2"
  style="
    padding:22px 0 0;
  "
>

<div
  style="
    height:1px;
    line-height:1px;
    background:#4f6a5f;
  "
>
&nbsp;
</div>

</td>

</tr>


<tr>

<td
  colspan="2"
  class="h1"
  style="
    padding:22px 0 8px;
    font-family:
      'PMingLiU',
      serif;
    font-size:26px;
    font-weight:bold;
    line-height:1.35;
    color:#ffffff;
  "
>

收到一筆免費初步評估申請

</td>

</tr>


<tr>

<td
  colspan="2"
  style="
    font-family:
      'Microsoft JhengHei',
      sans-serif;
    font-size:14px;
    color:#cfdad5;
  "
>

${escapeHtml(submittedAt)}
 · 來自 full-home.com.tw

</td>

</tr>

</table>

</td>

</tr>


<!-- CONTACT -->

<tr>

<td
  class="px"
  style="
    padding:30px 36px;
    border-bottom:
      1px solid #e6e1d6;
    font-family:
      'Microsoft JhengHei',
      sans-serif;
  "
>

<div
  style="
    font-size:12px;
    font-weight:bold;
    color:#7d5f2e;
    letter-spacing:2px;
    padding-bottom:14px;
  "
>

聯絡人

</div>


<div
  style="
    font-family:
      'PMingLiU',
      serif;
    font-size:28px;
    font-weight:bold;
    color:#1d2522;
    line-height:1.3;
  "
>

${escapeHtml(name)}

</div>


<div
  style="
    padding:4px 0 20px;
  "
>

<a
  href="tel:${phoneRaw}"
  style="
    font-size:20px;
    color:#16352d;
    text-decoration:none;
    letter-spacing:1px;
  "
>

${escapeHtml(phone)}

</a>

</div>


<a
  class="btn"
  href="tel:${phoneRaw}"
  style="
    display:inline-block;
    background:#16352d;
    color:#ffffff;
    font-size:15px;
    font-weight:bold;
    text-decoration:none;
    padding:12px 24px;
    border-radius:4px;
    margin-right:10px;
    text-align:center;
  "
>

立即回電

</a>


<a
  class="btn"
  href="https://www.google.com/maps/search/?api=1&amp;query=${addressUrl}"
  style="
    display:inline-block;
    background:#ffffff;
    color:#16352d;
    border:1px solid #16352d;
    font-size:15px;
    font-weight:bold;
    text-decoration:none;
    padding:11px 23px;
    border-radius:4px;
    text-align:center;
  "
>

地圖查看基地

</a>

</td>

</tr>


<!-- PROPERTY -->

<tr>

<td
  class="px"
  style="
    padding:30px 36px;
    border-bottom:
      1px solid #e6e1d6;
    font-family:
      'Microsoft JhengHei',
      sans-serif;
  "
>

<div
  style="
    font-size:12px;
    font-weight:bold;
    color:#7d5f2e;
    letter-spacing:2px;
    padding-bottom:10px;
  "
>

基地資訊

</div>


<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
  style="
    border-top:
      1px solid #ece7dc;
  "
>


<tr class="stack">

<td
  class="label"
  width="130"
  valign="top"
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:14px;
    color:#5a6661;
  "
>

基地地址

</td>


<td
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:16px;
    color:#1d2522;
    line-height:1.6;
  "
>

${escapeHtml(address)}

</td>

</tr>


<tr class="stack">

<td
  class="label"
  width="130"
  valign="top"
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:14px;
    color:#5a6661;
  "
>

建物屋齡

</td>


<td
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:16px;
    color:#1d2522;
  "
>

${escapeHtml(
  age || "未填寫"
)}

</td>

</tr>


<tr class="stack">

<td
  class="label"
  width="130"
  valign="top"
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:14px;
    color:#5a6661;
  "
>

地主／住戶概況

</td>


<td
  style="
    padding:13px 0;
    border-bottom:
      1px solid #ece7dc;
    font-size:16px;
    color:#1d2522;
    line-height:1.6;
  "
>

${escapeHtml(
  owners || "未填寫"
)}

</td>

</tr>

</table>

</td>

</tr>


<!-- REQUEST -->

<tr>

<td
  class="px"
  style="
    padding:30px 36px 34px;
    font-family:
      'Microsoft JhengHei',
      sans-serif;
  "
>

<div
  style="
    font-size:12px;
    font-weight:bold;
    color:#7d5f2e;
    letter-spacing:2px;
    padding-bottom:14px;
  "
>

諮詢需求

</div>


<table
  role="presentation"
  width="100%"
  cellpadding="0"
  cellspacing="0"
  border="0"
>

<tr class="stack">

<td
  class="label"
  width="130"
  valign="middle"
  style="
    padding:0 0 16px;
    font-size:14px;
    color:#5a6661;
  "
>

希望了解

</td>


<td
  style="
    padding:0 0 16px;
  "
>

<span
  style="
    display:inline-block;
    background:#e6ede9;
    color:#16352d;
    font-size:14px;
    font-weight:bold;
    padding:4px 12px;
    border-radius:999px;
  "
>

${escapeHtml(type)}

</span>

</td>

</tr>

</table>


<div
  style="
    font-size:14px;
    color:#5a6661;
    padding-bottom:8px;
  "
>

其他說明

</div>


<div
  style="
    background:#f7f4ee;
    border-radius:4px;
    padding:16px 20px;
    font-size:15px;
    line-height:1.8;
    color:#1d2522;
  "
>

${escapeHtml(
  message || "未填寫"
).replaceAll("\n", "<br>")}

</div>

</td>

</tr>

</table>

</td>

</tr>


<!-- FOOTER -->

<tr>

<td
  style="
    padding:20px 6px 0;
    font-family:
      'Microsoft JhengHei',
      sans-serif;
    font-size:12px;
    line-height:1.7;
    color:#5a6661;
  "
>

<strong
  style="
    color:#16352d;
  "
>
馥鴻建設股份有限公司
</strong>

<br>

臺北市中山區南京東路三段65號7樓

 ·

02-7701-6887

 ·

<a
  href="https://www.full-home.com.tw/"
  style="
    color:#16352d;
  "
>
full-home.com.tw
</a>

<br>

此郵件由官網表單自動寄送，
請勿直接回覆；
客戶個資僅供本次諮詢聯繫使用。

</td>

</tr>

</table>

</td>

</tr>

</table>

</body>

</html>
`;

      /*
       * 收件人
       * 全部使用 BCC
       */
      const recipientAddresses =
        String(
          env.MAIL_TO ||
            "mis@da-li.com.tw,ira.peng@full-home.com.tw,kevin.hsieh@full-home.com.tw"
        )
          .split(",")
          .map(
            value =>
              value.trim()
          )
          .filter(Boolean);

      const recipients =
        recipientAddresses.map(
          address => ({
            emailAddress: {
              address
            }
          })
        );

      /*
       * Microsoft Graph Send Mail
       */
      const graphResponse =
        await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
            env.MAIL_FROM
          )}/sendMail`,
          {
            method: "POST",

            headers: {
              Authorization:
                `Bearer ${tokenData.access_token}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                message: {
                  subject,

                  body: {
                    contentType:
                      "HTML",

                    content:
                      htmlBody
                  },

                  /*
                   * 密件副本
                   */
                  bccRecipients:
                    recipients
                },

                saveToSentItems:
                  true
              })
          }
        );

      if (!graphResponse.ok) {
        const graphError =
          await graphResponse.text();

        console.error(
          "Microsoft Graph sendMail error:",
          graphResponse.status,
          graphError
        );

        return json(
          {
            ok: false,
            message:
              "郵件寄送失敗，請稍後再試。"
          },
          502
        );
      }

      return json({
        ok: true,
        message: "資料已送出。"
      });

    } catch (error) {

      console.error(
        "Worker error:",
        error
      );

      return json(
        {
          ok: false,
          message:
            "系統暫時無法處理，請稍後再試。"
        },
        500
      );
    }
  }
};


/*
 * 電話格式整理
 */
function normalizeTaiwanPhone(value) {

  return String(value ?? "")
    .trim()
    .replace(
      /[()\s-]/g,
      ""
    )
    .replace(
      /^\+886/,
      "0"
    )
    .replace(
      /^886/,
      "0"
    );

}


/*
 * 台灣電話驗證
 */
function isValidTaiwanPhone(value) {

  const phone =
    normalizeTaiwanPhone(value);

  /*
   * 手機
   * 09xxxxxxxx
   */
  if (
    /^09\d{8}$/.test(phone)
  ) {
    return true;
  }

  /*
   * 台北 / 新北常見
   */
  if (
    /^02\d{8}$/.test(phone)
  ) {
    return true;
  }

  /*
   * 03 ~ 08
   */
  if (
    /^0[3-8]\d{7,8}$/.test(
      phone
    )
  ) {
    return true;
  }

  /*
   * 082 / 0836 / 089 等
   */
  if (
    /^0\d{2,3}\d{6,8}$/.test(
      phone
    ) &&
    phone.length >= 9 &&
    phone.length <= 11
  ) {
    return true;
  }

  return false;
}


/*
 * 清理文字
 */
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


/*
 * HTML Escape
 */
function escapeHtml(value) {

  return String(value)

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
      '"',
      "&quot;"
    )

    .replaceAll(
      "'",
      "&#039;"
    );

}


/*
 * JSON Response
 */
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
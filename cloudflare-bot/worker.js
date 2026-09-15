/**
 * 📬 Temp Mail Bot — all-in-one Cloudflare Worker
 * Telegram bot + Email receiver + D1 database — بدون نیاز به Railway
 *
 * Bindings (wrangler.toml):
 *   - D1 database: DB
 *   - Vars: BOT_TOKEN, ADMIN_IDS (csv of telegram user ids), SECRET
 * Commands: /start panel; inline buttons for everything.
 */

const DOMAINS = ["mesterio.life", "iprez.dpdns.org"];

// ---------- helpers ----------
const esc = (t) => (t || "").toString()
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  try { return await r.json(); } catch { return null; }
}

const sendMsg = (env, chat_id, text, kb) => tg(env, "sendMessage", {
  chat_id, text, parse_mode: "HTML",
  ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
});

const answer = (env, id, text) => tg(env, "answerCallbackQuery", {
  callback_query_id: id, ...(text ? { text } : {}),
});

// ---------- main panel ----------
function mainPanelKB() {
  return [[
    { text: "🎲 Random", callback_data: "dom:new:random" },
    { text: "✏️ Custom", callback_data: "dom:new:custom" },
  ], [
    { text: "📬 My Email", callback_data: "myemail" },
  ], [
    { text: "🧑‍💼 Admin", callback_data: "admin" },
  ]];
}

// انتخاب دامنه — اولین قدم ساخت آدرس
function domainKB(action, mode) {
  const kb = DOMAINS.map(d => [{ text: `🌐 @${d}`, callback_data: `pick:${action}:${mode}:${d}` }]);
  kb.push([{ text: "🏠 Panel", callback_data: "home" }]);
  return kb;
}

function panelText(addrCount, domain) {
  return `📬 <b>Temp Mail Panel</b>\n` +
    `🌐 Domain: <code>@${esc(domain)}</code>\n` +
    `📮 آدرس‌های فعال شما: <b>${addrCount}</b>\n\n` +
    `🎲 <b>Random</b> — آدرس تصادفی بساز\n` +
    `✏️ <b>Custom</b> — با اسم دلخواه بساز\n` +
    `📬 <b>My Email</b> — لیست همه آدرس‌هات و سوییچ بین‌شون\n` +
    `🧑‍💼 <b>Admin</b> — پنل مدیریت (فقط ادمین)`;
}

// ---------- DB init ----------
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  address TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS mails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  sender TEXT,
  subject TEXT,
  body TEXT,
  raw_snippet TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_addr_user ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_mails_addr ON mails(address, received_at DESC);
`;

async function initDB(db) {
  for (const stmt of INIT_SQL.split(";")) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
}

// ---------- address creation ----------
const randLocal = () => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 8; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

async function createAddress(env, db, userId, local, domain) {
  local = (local || "").trim().toLowerCase();
  if (local) {
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(local)) {
      return { error: "❌ اسم باید ۳ تا ۳۰ کاراکتر و فقط حرف انگلیسی/عدد/._- باشه." };
    }
  } else {
    local = randLocal();
  }
  domain = (domain || env.MAIL_DOMAIN || DOMAINS[0]).toLowerCase();
  if (!DOMAINS.includes(domain)) return { error: "⛔️ دامنه نامعتبر." };
  const address = `${local}@${domain}`;
  try {
    await db.prepare(
      "INSERT INTO addresses (user_id, address, created_at, last_used) VALUES (?, ?, ?, ?)"
    ).bind(userId, address, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)).run();
    return { address };
  } catch (e) {
    if (e.message && e.message.includes("UNIQUE")) {
      return { error: "❌ این آدرس قبلاً گرفته شده. یه اسم دیگه امتحان کن." };
    }
    return { error: "❌ خطای دیتابیس: " + e.message };
  }
}

// set at request time from env

// ---------- inbox view ----------
async function inboxText(db, address) {
  const rows = await db.prepare(
    "SELECT sender, subject, body, received_at FROM mails WHERE address = ? ORDER BY received_at DESC, id DESC LIMIT 10"
  ).bind(address).all();
  const out = [`📥 <b>Inbox:</b> <code>${esc(address)}</code>\n`];
  if (!rows.results || !rows.results.length) {
    out.push("📭 هنوز ایمیلی به این آدرس نرسیده.\n⏳ منتظر ایمیل بمون یا ازش برای ثبت‌نام استفاده کن!");
  } else {
    for (const m of rows.results) {
      const t = new Date(m.received_at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
      out.push(`━━━━━━━━━━━━━━\n✉️ <b>From:</b> ${esc(m.sender || "?")}\n` +
        `📌 <b>Subject:</b> ${esc(m.subject) || "(بدون موضوع)"}\n` +
        `🕐 ${t}\n<pre>${esc((m.body || "").slice(0, 1200)) || "(خالی)"}</pre>`);
    }
  }
  return out.join("\n");
}

function inboxKB(address) {
  return [[
    { text: "🔄 Refresh", callback_data: `inbox:${address}` },
  ], [
    { text: "📬 My Email", callback_data: "myemail" },
    { text: "🏠 Panel", callback_data: "home" },
  ]];
}

// ---------- my email (switcher) ----------
async function myEmailView(db, userId) {
  const rows = await db.prepare(
    "SELECT id, address, last_used FROM addresses WHERE user_id = ? ORDER BY last_used DESC"
  ).bind(userId).all();
  if (!rows.results || !rows.results.length) {
    return {
      text: "📬 <b>My Email</b>\n\nهنوز آدرسی نداری. اول با 🎲 یا ✏️ یکی بساز!",
      kb: [[{ text: "🎲 Random", callback_data: "dom:new:random" }], [{ text: "🏠 Panel", callback_data: "home" }]],
    };
  }
  const kb = [];
  for (const r of rows.results) {
    kb.push([{ text: `📥 ${r.address}`, callback_data: `inbox:${r.address}` }]);
    kb.push([
      { text: "✏️ Rename", callback_data: `rename:${r.id}` },
      { text: "🗑 Delete", callback_data: `del:${r.id}` },
    ]);
  }
  kb.push([{ text: "🏠 Panel", callback_data: "home" }]);
  return {
    text: `📬 <b>My Email</b> (${rows.results.length} آدرس)\n\nروی هر آدرس بزن تا اینباکسش باز شه — همه آدرس‌هات همیشه فعال و حفظ می‌شن ✅`,
    kb,
  };
}

// ---------- admin panel ----------
async function adminView(db, userId) {
  const admins = (envAdmins || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!admins.includes(String(userId))) {
    return { text: "⛔️ فقط ادمین دسترسی داره.", kb: [[{ text: "🏠 Panel", callback_data: "home" }]] };
  }
  const users = await db.prepare("SELECT COUNT(DISTINCT user_id) c FROM addresses").first();
  const u = await db.prepare("SELECT COUNT(*) c FROM addresses").first();
  const mailCount = await db.prepare("SELECT COUNT(*) c FROM mails").first();
  const mailTotal = mailCount ? mailCount.c : 0;
  const recent = await db.prepare(
    "SELECT address, sender, subject, received_at FROM mails ORDER BY received_at DESC, id DESC LIMIT 5"
  ).all();
  let lines = [`🧑‍💼 <b>Admin Panel</b>\n\n👥 Users: <b>${users.c}</b>\n📮 Addresses: <b>${u.c}</b>\n✉️ Mails: <b>${mailTotal}</b>\n\n<b>آخرین ایمیل‌ها:</b>`];
  for (const r of (recent.results || [])) {
    const t = new Date(r.received_at * 1000).toISOString().slice(5, 16).replace("T", " ");
    lines.push(`• <code>${esc(r.address)}</code> ← ${esc(r.sender || "?")} — ${esc(r.subject || "")} (${t})`);
  }
  return {
    text: lines.join("\n"),
    kb: [
      [{ text: "📊 Stats", callback_data: "admin" }, { text: "🧹 Purge old mails", callback_data: "purge" }],
      [{ text: "🏠 Panel", callback_data: "home" }],
    ],
  };
}

// read env refs into locals (set in handleUpdate/inbound)
let envAdmins = "";

// /rename <id> <newname> — تغییر label آدرس (آدرس واقعی عوض نمی‌شه، فقط اسم نمایشی)
async function handleRename(env, db, chatId, userId, text) {
  const m = text.match(/^\/rename\s+(\d+)\s+([a-z0-9._-]{2,20})$/i);
  if (!m) return sendMsg(env, chatId, "فرمت: <code>/rename آیدی_آدرس اسم_جدید</code>\nآیدی رو از My Email بگیر.");
  const r = await db.prepare("UPDATE addresses SET label = ? WHERE id = ? AND user_id = ?")
    .bind(m[2], parseInt(m[1]), userId).run();
  return sendMsg(env, chatId, r.meta.changes ? "✏️ اسم نمایشی تغییر کرد ✅" : "⛔️ آدرس پیدا نشد.");
}

// ---------- command handlers ----------
async function handleUpdate(env, upd) {
  envAdmins = env.ADMIN_IDS || "";
  const db = env.DB;
  await initDB(db);

  if (upd.callback_query) return handleCallback(env, db, upd.callback_query);
  const msg = upd.message || upd.edited_message;
  if (!msg || !msg.from) return "ok";
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = (msg.text || "").trim();

  if (text.startsWith("/start")) {
    const c = await db.prepare("SELECT COUNT(*) c FROM addresses WHERE user_id = ?").bind(userId).first();
    return sendMsg(env, chatId, panelText(c.c, DOMAINS.join(", ")), mainPanelKB());
  }

  // /make name — custom address
  const mk = text.match(/^\/make\s+([^\s@]+)(?:@([^\s]+))?/i);
  const mkDomain = mk && mk[2] && DOMAINS.includes(mk[2].toLowerCase()) ? mk[2].toLowerCase() : null;
  if (mk && mk[2] && !mkDomain) return sendMsg(env, chatId, "⛔️ دامنه مجاز نیست. دامنه‌های موجود: " + DOMAINS.join(", "));
  if (mk && mk[1]) {
    const res = await createAddress(env, db, userId, mk[1], mkDomain);
    if (res.error) return sendMsg(env, chatId, res.error);
    return sendMsg(env, chatId,
      `✅ آدرس ساخته شد:\n<code>${esc(res.address)}</code>\n\n📬 از <b>My Email</b> بهش دسترسی داری — همیشه فعال می‌مونه.`,
      [[{ text: "📥 باز کردن Inbox", callback_data: `inbox:${res.address}` }], [{ text: "📬 My Email", callback_data: "myemail" }]]);
  }

  // /new — به پنل با انتخاب دامنه هدایت
  if (text.startsWith("/new")) {
    return sendMsg(env, chatId, "🌐 اول دامنه رو انتخاب کن:", domainKB("new", "random"));
  }

  // /rename id newname
  if (text.startsWith("/rename")) {
    return handleRename(env, db, chatId, userId, text);
  }

  // /inbox [address]
  if (text.startsWith("/inbox")) {
    const arg = text.split(/\s+/)[1];
    let addr = arg;
    if (!addr) {
      const rows = await db.prepare(
        "SELECT address FROM addresses WHERE user_id = ? ORDER BY last_used DESC LIMIT 1"
      ).bind(userId).first();
      addr = rows && rows.address;
    }
    if (!addr) return sendMsg(env, chatId, "آدرسی نداری. با 🎲 یکی بساز!");
    const own = await db.prepare("SELECT 1 FROM addresses WHERE user_id = ? AND address = ?")
      .bind(userId, addr).first();
    if (!own) return sendMsg(env, chatId, "⛔️ این آدرس مال شما نیست.");
    return sendMsg(env, chatId, await inboxText(db, addr), inboxKB(addr));
  }

  // /setdomain (admin) — sync check
  if (text.startsWith("/id")) {
    return sendMsg(env, chatId, `🆔 Your ID: <code>${userId}</code>`);
  }

  return sendMsg(env, chatId, panelText("·", DOMAINS.join(", ")), mainPanelKB());
}

async function handleCallback(env, db, q) {
  const userId = q.from.id;
  const msg = q.message || {};
  const chatId = msg.chat && msg.chat.id;
  const msgId = msg.message_id;
  const data = q.data || "";
  const edit = async (text, kb) => {
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: msgId, text, parse_mode: "HTML",
      ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
    });
  };

  try {
    if (data === "home") {
      const c = await db.prepare("SELECT COUNT(*) c FROM addresses WHERE user_id = ?").bind(userId).first();
      return await edit(panelText(c.c, DOMAINS.join(", ")), mainPanelKB());
    }

    if (data.startsWith("dom:")) {
      // نمایش انتخاب دامنه
      const [, action, mode] = data.split(":");
      return await edit(
        mode === "random" ? "🌐 برای آدرس تصادفی، دامنه رو انتخاب کن:" : "🌐 برای آدرس دلخواه، دامنه رو انتخاب کن:",
        domainKB(action, mode));
    }

    if (data.startsWith("pick:")) {
      // pick:action:mode:domain
      const [, action, mode, domain] = data.split(":");
      if (mode === "random") {
        const res = await createAddress(env, db, userId, "", domain);
        if (res.error) { await answer(env, q.id, res.error); return await edit(res.error, mainPanelKB()); }
        await answer(env, q.id, "✅ ساخته شد!");
        return await edit(`✅ آدرس تصادفی:\n<code>${esc(res.address)}</code>`,
          [[{ text: "📥 باز کردن Inbox", callback_data: `inbox:${res.address}` }], [{ text: "🏠 Panel", callback_data: "home" }]]);
      }
      // custom: راهنمای /make با دامنه انتخابی
      return await edit(
        `✏️ <b>Custom روی @${esc(domain)}</b>\n\nاسم دلخواهت رو بفرست:\n<code>/make myname@${esc(domain)}</code>`,
        [[{ text: "🏠 Panel", callback_data: "home" }]]);
    }

    if (data === "myemail") {
      const v = await myEmailView(db, userId);
      return await edit(v.text, v.kb);
    }

    if (data.startsWith("inbox:")) {
      const addr = data.slice(6);
      const own = await db.prepare("SELECT 1 FROM addresses WHERE user_id = ? AND address = ?")
        .bind(userId, addr).first();
      if (!own) { await answer(env, q.id, "⛔️ این آدرس مال شما نیست."); return "ok"; }
      await db.prepare("UPDATE addresses SET last_used = ? WHERE address = ?")
        .bind(Math.floor(Date.now() / 1000), addr).run();
      return await edit(await inboxText(db, addr), inboxKB(addr));
    }

    if (data.startsWith("del:")) {
      const id = parseInt(data.slice(4));
      const row = await db.prepare("SELECT address FROM addresses WHERE id = ? AND user_id = ?")
        .bind(id, userId).first();
      if (row) {
        await db.prepare("DELETE FROM addresses WHERE id = ?").bind(id).run();
        await db.prepare("DELETE FROM mails WHERE address = ?").bind(row.address).run();
        await answer(env, q.id, "🗑 حذف شد");
      }
      const v = await myEmailView(db, userId);
      return await edit(v.text, v.kb);
    }

    if (data.startsWith("rename:")) {
      const id = data.slice(7);
      const row = await db.prepare("SELECT address, label FROM addresses WHERE id = ? AND user_id = ?")
        .bind(parseInt(id), userId).first();
      if (!row) { await answer(env, q.id, "⛔️ پیدا نشد"); return "ok"; }
      return await edit(
        `✏️ <b>Rename</b>\n\nآدرس: <code>${esc(row.address)}</code>\nاسم فعلی: <b>${esc(row.label) || "—"}</b>\n\nبرای تغییر بفرست:\n<code>/rename ${id} newname</code>`,
        [[{ text: "📬 My Email", callback_data: "myemail" }]]);
    }

    if (data === "admin") {
      const v = await adminView(db, userId);
      return await edit(v.text, v.kb);
    }

    if (data === "purge") {
      const admins = (envAdmins || "").split(",").map(s => s.trim());
      if (!admins.includes(String(userId))) { await answer(env, q.id, "⛔️ ادمین نیستی"); return "ok"; }
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
      const r = await db.prepare("DELETE FROM mails WHERE received_at < ?").bind(cutoff).run();
      await answer(env, q.id, `🧹 ${r.meta.changes || 0} ایمیل قدیمی پاک شد`);
      return "ok";
    }
  } catch (e) {
    await answer(env, q.id, "خطا: " + e.message).catch(() => {});
  }
  await answer(env, q.id);
  return "ok";
}

// ---------- email receiving (Cloudflare Email Routing) ----------
function decodeQuotedPrintable(s) {
  // بایت‌محور. =XX فقط وقتی decode شه که context نشونه انکودینگ واقعی باشه:
  // UTF-8 lead bytes (>=C2) همیشه decode؛ else اگر بعدش URL-safe نیاد decode، وگرنه literal (=).
  const bytes = [];
  let i = 0;
  const clean = s.replace(/=\r?\n/g, "");
  while (i < clean.length) {
    const c = clean[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(clean.substr(i + 1, 2))) {
      const pair = clean.substr(i + 1, 2);
      const val = parseInt(pair, 16);
      const after = clean[i + 3];
      const afterUrlish = after !== undefined && /[A-Za-z0-9\-._~]/.test(after);
      const isUtf8Lead = val >= 0xC2; // UTF-8 continuation/lead — هرگز در URL به این شکل از = شروع نمی‌شه
      const isControl = val < 0x20 || val === 0x3D; // newline, tab, =3D escaped '='
      if (isUtf8Lead || isControl || !afterUrlish) {
        bytes.push(val); i += 3; continue;
      }
      bytes.push(c.charCodeAt(0) & 0xff); i++; // literal '=' (URL مثل token=abc123)
    } else {
      bytes.push(clean.charCodeAt(i) & 0xff);
      i++;
    }
  }
  try { return new TextDecoder().decode(Uint8Array.from(bytes)); } catch { return clean; }
}

function htmlToText(html) {
  let t = html;
  // لینک‌ها: متن + URL نگه داشته شه
  t = t.replace(/<a\s[^>]*href\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, txt) => {
      const clean = txt.replace(/<[^>]+>/g, "").trim();
      return clean ? `${clean} (${href})` : href;
    });
  t = t.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n");
  t = t.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
  t = t.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n");
  return t.trim();
}

function parseEmail(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const header = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd).trim();

  const getHeader = (name) => {
    const m = header.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, "im"));
    return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
  };

  const decodeBody = (part) => {
    const cte = (part.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || "";
    // بدنه part بعد از اولین \r\n\r\n (هدر part جدا می‌شه)
    const pEnd = part.indexOf("\r\n\r\n") !== -1 ? part.indexOf("\r\n\r\n") : part.indexOf("\n\n");
    let out = pEnd !== -1 ? part.slice(pEnd).trim() : part.trim();
    if (/base64/i.test(cte)) {
      try {
        const b64 = out.replace(/[^A-Za-z0-9+/=]/g, "");
        const bin = atob(b64.slice(0, Math.floor(b64.length / 4) * 4));
        out = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      } catch { /* keep */ }
    } else if (/quoted-printable/i.test(cte)) {
      out = decodeQuotedPrintable(out);
    }
    // مرزبند: اگر part با --boundary دیگری ادامه پیدا کرده بود، برش بزن (دیفنس در عمق)
    return out;
  };

  // split multipart — boundary در هدر بالاست (یا در body برای nested)
  const bMatch = (getHeader("Content-Type").match(/boundary\s*=\s*"?([^";\r\n]+)"?/i)
    || body.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i));
  let textPlain = null, textHtml = null;

  if (bMatch) {
    const boundary = bMatch[1];
    const parts = body.split("--" + boundary);
    for (const p of parts.slice(1)) {
      if (p.startsWith("--")) break; // end marker
      // part ممکنه حاوی boundary بعدی هم باشه — برش تا اولین boundary داخلی
      const part = p.replace(/\r\n--\r?\n?[\s\S]*$/, "").replace(/\n--[^\n]*[\s\S]*$/, "");
      if (/Content-Type:\s*text\/plain/i.test(part) && textPlain === null) textPlain = decodeBody(part);
      else if (/Content-Type:\s*text\/html/i.test(part) && textHtml === null) textHtml = decodeBody(part);
      else if (/Content-Type:\s*multipart/i.test(p)) {
        // nested multipart (e.g. multipart/alternative داخل related)
        const nested = p.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i);
        if (nested) {
          for (const np of p.split("--" + nested[1]).slice(1)) {
            if (/Content-Type:\s*text\/plain/i.test(np) && textPlain === null) textPlain = decodeBody(np);
            else if (/Content-Type:\s*text\/html/i.test(np) && textHtml === null) textHtml = decodeBody(np);
          }
        }
      }
    }
  } else {
    // non-multipart: کل بدنه
    const ct = getHeader("Content-Type") || "";
    if (/text\/html/i.test(ct)) textHtml = decodeBody(body);
    else textPlain = decodeBody(body);
  }

  let picked = textPlain !== null ? textPlain.trim() : null;
  if ((!picked || picked.length < 5) && textHtml !== null) {
    picked = htmlToText(textHtml);
  }
  picked = (picked || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 3500);

  return {
    from: getHeader("From"),
    subject: decodeMimeWords(getHeader("Subject")),
    body: picked || "(بدون متن قابل نمایش)",
  };
}

function decodeMimeWords(s) {
  return (s || "").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      if (enc.toLowerCase() === "b") {
        const bin = atob(txt);
        return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
      }
      return decodeQuotedPrintable(txt.replace(/_/g, " "));
    } catch { return txt; }
  });
}

async function handleEmail(env, message) {
  const db = env.DB;
  await initDB(db);

  const raw = await new Response(message.raw).text();
  const to = (message.to || "").toLowerCase();
  const { from, subject, body } = parseEmail(raw);

  // آدرس‌های ناشناس هم ذخیره می‌شن تا اگر بعداً با /make ساخته شد، ایمیل‌های قبلی دیدنی باشن
  await db.prepare(
    "INSERT INTO mails (address, sender, subject, body, received_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(to, from, subject, body, Math.floor(Date.now() / 1000)).run();

  // اعلان فقط به صاحب آدرس (تفکیک کامل)
  const owner = await db.prepare("SELECT user_id FROM addresses WHERE address = ?").bind(to).first();
  if (owner) {
    await tg(env, "sendMessage", {
      chat_id: owner.user_id,
      parse_mode: "HTML",
      text: `📩 <b>ایمیل جدید!</b>\n📥 To: <code>${esc(to)}</code>\n✉️ From: ${esc(from)}\n📌 Subject: ${esc(subject) || "(بدون موضوع)"}`,
      reply_markup: { inline_keyboard: [[{ text: "📥 خواندن", callback_data: `inbox:${to}` }]] },
    });
  }
}

// ---------- worker entry ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
      envAdmins = env.ADMIN_IDS || "";

    if (url.pathname === "/health") return new Response("ok");

    // secret check for webhook
    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("method", { status: 405 });
      const upd = await request.json();
      await handleUpdate(env, upd);
      return json({ ok: true });
    }
    // setWebhook helper: GET /setwebhook?u=https://xxx.workers.dev
    if (url.pathname === "/setwebhook") {
      const base = url.searchParams.get("u") || url.origin;
      const r = await tg(env, "setWebhook", { url: `${base}/webhook`, allowed_updates: ["message", "callback_query"] });
      return json(r);
    }
    return new Response("Temp Mail Bot worker running. /health /webhook", { status: 200 });
  },

  async email(message, env) {
    await handleEmail(env, message);
  },
};

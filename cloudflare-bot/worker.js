/**
 * 📬 Temp Mail Bot — all-in-one Cloudflare Worker
 * Telegram bot + Email receiver + D1 database — بدون نیاز به Railway
 *
 * Bindings (wrangler.toml):
 *   - D1 database: DB
 *   - Vars: BOT_TOKEN, ADMIN_IDS (csv of telegram user ids), SECRET
 * Commands: /start panel; inline buttons for everything.
 */

const DOMAIN = "YOUR_DOMAIN"; // ← بعد از دیپلوی از var تنظیم می‌شود، این فقط fallback

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
    { text: "🎲 Random", callback_data: "new:random" },
    { text: "✏️ Custom", callback_data: "new:custom" },
  ], [
    { text: "📬 My Email", callback_data: "myemail" },
  ], [
    { text: "🧑‍💼 Admin", callback_data: "admin" },
  ]];
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

async function createAddress(env, db, userId, local) {
  local = (local || "").trim().toLowerCase();
  if (local) {
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(local)) {
      return { error: "❌ اسم باید ۳ تا ۳۰ کاراکتر و فقط حرف انگلیسی/عدد/._- باشه." };
    }
  } else {
    local = randLocal();
  }
  const domain = env.MAIL_DOMAIN || DOMAIN;
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
let envDomain = DOMAIN;

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
      kb: [[{ text: "🎲 Random", callback_data: "new:random" }], [{ text: "🏠 Panel", callback_data: "home" }]],
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
  envDomain = env.MAIL_DOMAIN || DOMAIN;
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
    return sendMsg(env, chatId, panelText(c.c, envDomain), mainPanelKB());
  }

  // /make name — custom address
  const mk = text.match(/^\/make\s+([^\s@]+)(?:@([^\s]+))?/i);
  if (mk) {
    const res = await createAddress(env, db, userId, mk[1]);
    if (res.error) return sendMsg(env, chatId, res.error);
    return sendMsg(env, chatId,
      `✅ آدرس ساخته شد:\n<code>${esc(res.address)}</code>\n\n📬 از <b>My Email</b> بهش دسترسی داری — همیشه فعال می‌مونه.`,
      [[{ text: "📥 باز کردن Inbox", callback_data: `inbox:${res.address}` }], [{ text: "📬 My Email", callback_data: "myemail" }]]);
  }

  // /new — random
  if (text.startsWith("/new")) {
    const res = await createAddress(env, db, userId, "");
    if (res.error) return sendMsg(env, chatId, res.error);
    return sendMsg(env, chatId,
      `✅ آدرس تصادفی:\n<code>${esc(res.address)}</code>`,
      [[{ text: "📥 باز کردن Inbox", callback_data: `inbox:${res.address}` }], [{ text: "📬 My Email", callback_data: "myemail" }]]);
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

  return sendMsg(env, chatId, panelText("·", envDomain), mainPanelKB());
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
      return await edit(panelText(c.c, envDomain), mainPanelKB());
    }

    if (data === "new:random") {
      const res = await createAddress(env, db, userId, "");
      if (res.error) { await answer(env, q.id, res.error); return await edit(res.error, mainPanelKB()); }
      await answer(env, q.id, "✅ ساخته شد!");
      return await edit(`✅ آدرس تصادفی:\n<code>${esc(res.address)}</code>`,
        [[{ text: "📥 باز کردن Inbox", callback_data: `inbox:${res.address}` }], [{ text: "🏠 Panel", callback_data: "home" }]]);
    }

    if (data === "new:custom") {
      return await edit(
        "✏️ <b>Custom Address</b>\n\nاسم دلخواهت رو با این فرمت بفرست:\n<code>/make myname</code>\n\nمثلاً: <code>/make rez.test</code> → <code>rez.test@" + esc(envDomain) + "</code>",
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
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi,
    (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseEmail(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n") !== -1 ? raw.indexOf("\r\n\r\n") : raw.indexOf("\n\n");
  const header = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd).trim();

  const getHeader = (name) => {
    const m = header.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, "im"));
    return m ? m[1].replace(/\r?\n[ \t]+/g, " ").trim() : "";
  };

  // decode base64 or QP transfer encoding
  const cte = (getHeader("Content-Transfer-Encoding") || "").toLowerCase();

  // try to find a text/plain part in multipart
  const plain = body.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\s*$)/i);
  let picked = plain ? plain[1] : body;
  const partCte = (picked.match(/Content-Transfer-Encoding:\s*(\S+)/i) || [])[1] || cte;
  if (/base64/i.test(partCte)) {
    try {
      const b64 = picked.replace(/[^A-Za-z0-9+/=]/g, "");
      const bin = atob(b64.slice(0, Math.floor(b64.length / 4) * 4));
      // UTF-8 safe decode
      picked = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } catch { /* keep as is */ }
  } else if (/quoted-printable/i.test(partCte)) {
    picked = decodeQuotedPrintable(picked);
  }
  // strip remaining base64 header noise if multipart fallback
  if (plain) picked = picked.replace(/^[\s\S]*?\r?\n\r?\n/, "");
  picked = picked.replace(/\r\n/g, "\n").trim().slice(0, 4000);

  return {
    from: getHeader("From"),
    subject: decodeMimeWords(getHeader("Subject")),
    body: picked,
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
  envDomain = env.MAIL_DOMAIN || DOMAIN;
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
    envDomain = env.MAIL_DOMAIN || DOMAIN;
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

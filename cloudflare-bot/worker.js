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
function mainPanelKB(isAdmin = false) {
  const kb = [[
    { text: "🎲 Random", callback_data: "dom:new:random" },
    { text: "✏️ Custom", callback_data: "dom:new:custom" },
  ], [
    { text: "📬 My Email", callback_data: "myemail" },
  ]];
  // پنل ادمین فقط با /panel — در منوی اصلی نیست
  return kb;
}

// انتخاب دامنه — اولین قدم ساخت آدرس
function domainKB(action, mode) {
  const kb = DOMAINS.map(d => [{ text: `🌐 @${d}`, callback_data: `pick:${action}:${mode}:${d}` }]);
  kb.push([{ text: "🏠 Panel", callback_data: "home" }]);
  return kb;
}

function panelText(addrCount, domains) {
  return `╭─────────────────────\n` +
    `┃ 📬 <b>Temp Mail</b>\n` +
    `┃ 🌐 دامنه‌ها: <code>${esc(domains)}</code>\n` +
    `┃ 📮 آدرس‌های شما: <b>${addrCount}</b>\n` +
    `╰─────────────────────\n\n` +
    `🎲 <b>Random</b> — آدرس تصادفی بساز\n` +
    `✏️ <b>Custom</b> — با اسم دلخواه بساز\n` +
    `📬 <b>My Email</b> — همه آدرس‌هات و اینباکس‌ها\n\n` +
    `💡 ایمیل که بیاد فوری خبر می‌دم؛ لینک‌های Confirm دکمه می‌شن — تپ کن باز شه!`;
}

// ---------- DB init ----------
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  address TEXT NOT NULL UNIQUE,
  label TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used INTEGER DEFAULT 0,
  expires_at INTEGER DEFAULT 0
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

// مهاجرت + پاکسازی — فقط یک‌بار به ازای هر isolate (نه هر آپدیت — وگرنه کند می‌شه)
let dbReady = null;
let lastCleanup = 0;
async function initDB(db) {
  if (!dbReady) {
    dbReady = (async () => {
      for (const stmt of INIT_SQL.split(";")) {
        const s = stmt.trim();
        if (s) await db.prepare(s).run();
      }
      try {
        await db.prepare("ALTER TABLE addresses ADD COLUMN expires_at INTEGER DEFAULT 0").run();
      } catch { /* ستون هست */ }
    })().catch(e => { dbReady = null; throw e; });
  }
  await dbReady;
  // پاکسازی آدرس‌های منقضی: حداکثر هر ۱۰ دقیقه یک‌بار
  const now = Math.floor(Date.now() / 1000);
  if (now - lastCleanup > 600) {
    lastCleanup = now;
    try {
      await db.prepare("DELETE FROM mails WHERE address IN (SELECT address FROM addresses WHERE expires_at > 0 AND expires_at < ?)").bind(now).run();
      await db.prepare("DELETE FROM addresses WHERE expires_at > 0 AND expires_at < ?").bind(now).run();
    } catch { /* ignore */ }
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
// استخراج لینک‌های مهم از بدنه ایمیل (لینک تأیید، OTP و...)
function extractLinks(body) {
  const urls = (body || "").match(/https?:\/\/[^\s)<>"']+/g) || [];
  // dedupe + حذف trailing punctuation
  return [...new Set(urls.map(u => u.replace(/[.,;:)\]]+$/, "")))].slice(0, 5);
}

// استخراج کد OTP از متن ایمیل (۴ تا ۸ رقم، با کلمات کلیدی)
function extractOtp(body) {
  if (!body) return null;
  const patterns = [
    /(?:code|otp|pin|password|verification|confirm|token|کد)\s*(?:is|:|=)?\s*\D{0,10}\b(\d{4,8})\b/i,
    /\b(\d{6})\b/, // ۶ رقم — رایج‌ترین
    /\b(\d{4,8})\b/,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[1];
  }
  return null;
}

async function inboxText(db, address, offset = 0) {
  const PAGE = 10;
  const rows = await db.prepare(
    "SELECT sender, subject, body, received_at FROM mails WHERE address = ? ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?"
  ).bind(address, PAGE + 1, offset).all();
  const hasMore = (rows.results || []).length > PAGE;
  const list = (rows.results || []).slice(0, PAGE);
  const out = [`📥 <b>Inbox:</b> <code>${esc(address)}</code>\n`];
  if (!list.length) {
    out.push(offset > 0 ? "📭 به همینجا رسیدیم — ایمیل قدیمی‌تری نیست." : "📭 هنوز ایمیلی به این آدرس نرسیده.\n⏳ منتظر ایمیل بمون یا ازش برای ثبت‌نام استفاده کن!");
    return { text: out.join("\n"), links: [], otps: [], hasMore: false };
  }
  let newestLinks = [], newestOtps = [];
  for (const m of list) {
    const t = new Date(m.received_at * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    // نمایش متن بدون لینک‌ها (لینک‌ها دکمه می‌شن)
    const clean = (m.body || "")
      .replace(/(https?:\/\/[^\s)<>"']+)/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n\s*\n+/g, "\n\n")
      .replace(/\s*\(\s*\)/g, "")
      .trim();
    const links = extractLinks(m.body);
    const otp = extractOtp(m.body);
    if (!newestLinks.length) newestLinks = links;
    if (!newestOtps.length && otp) newestOtps = [{ code: otp, subject: m.subject || "" }];
    const who = (m.sender || "?").replace(/^"?([^"<]+)"?\s*</, "$1").replace(/<[^>]*>/, "").trim();
    // کد OTP بزرگ و برجسته داخل کارت
    const otpLine = otp ? `\n🔐 <b>کد:</b> <code><b>${otp}</b></code>\n` : "";
    out.push(`━━━━━━━━━━━━━━\n✉️ <b>From:</b> ${esc(who)}\n` +
      `📌 <b>Subject:</b> ${esc(m.subject) || "(بدون موضوع)"}\n` +
      `🕐 ${t}${otpLine}\n${esc(clean.slice(0, 900)) || "(خالی)"}`);
  }
  return { text: out.join("\n"), links: newestLinks, otps: newestOtps, hasMore, offset };
}

function linkLabel(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^www\./, "");
    // فقط path بررسی شه — query params مثل pcpid=confirm گمراه‌کننده‌ان
    const path = url.pathname.toLowerCase();
    if (/confirm|verify|activate|validate/.test(path)) return `✅ Confirm — ${host}`;
    if (/reset|password/.test(path)) return `🔑 Reset Password — ${host}`;
    if (/login|signin/.test(path)) return `🔓 Login — ${host}`;
    if (/upgrade|premium|pro|pricing|plans/.test(path)) return `⭐️ Upgrade — ${host}`;
    return `🔗 Open — ${host}`;
  } catch { return "🔗 Open Link"; }
}

function inboxKB(address, links = [], otps = [], hasMore = false, offset = 0) {
  const kb = [];
  // 🔐 دکمه کپی OTP — بالای همه دکمه‌ها
  for (const o of (otps || [])) {
    kb.push([{ text: `🔐 کپی کد: ${o.code}`, callback_data: `copyotp:${o.code}` }]);
  }
  // دکمه‌های لینک — تپ مستقیم، بدون کپی
  for (const u of links) {
    kb.push([{ text: linkLabel(u), url: u }]);
  }
  const nav = [{ text: "🔄 Refresh", callback_data: `inbox:${address}` }];
  if (hasMore) nav.push({ text: `⬅️ قدیمی‌ترها (صفحه ${Math.floor(offset / 10) + 2})`, callback_data: `inboxpage:${address}:${offset + 10}` });
  kb.push(nav);
  kb.push([
    { text: "📬 My Email", callback_data: "myemail" },
    { text: "🏠 Panel", callback_data: "home" },
  ]);
  return kb;
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
const isAdmin = (userId) => (envAdmins || "").split(",").map(s => s.trim()).filter(Boolean).includes(String(userId));

async function adminView(db, userId, section = "stats", arg = null) {
  if (!isAdmin(userId)) {
    return { text: "⛔️ فقط ادمین دسترسی داره.", kb: [[{ text: "🏠 Panel", callback_data: "home" }]] };
  }

  const back = [[{ text: "⬅️ Admin Home", callback_data: "admin" }, { text: "🏠 Panel", callback_data: "home" }]];

  // ---- بخش‌های مختلف ----
  if (section === "user") {
    // پروفایل کامل یک کاربر
    const uid = parseInt(arg);
    const addrs = await db.prepare("SELECT id, address, label, created_at FROM addresses WHERE user_id = ? ORDER BY created_at DESC").bind(uid).all();
    const mailCount = await db.prepare("SELECT COUNT(*) c FROM mails WHERE address IN (SELECT address FROM addresses WHERE user_id = ?)").bind(uid).first();
    let t = `👤 <b>کاربر</b> <code>${uid}</code>\n\n📮 آدرس‌ها: <b>${addrs.results.length}</b>\n✉️ ایمیل‌ها: <b>${mailCount.c}</b>\n`;
    const kb = [];
    for (const a of (addrs.results || []).slice(0, 15)) {
      kb.push([{ text: `📥 ${a.label ? a.label + " · " : ""}${a.address}`, callback_data: `adminmail:${a.address}` }]);
    }
    kb.push([{ text: "🗑 حذف کاربر و همه آدرس‌ها", callback_data: `deluser:${uid}` }]);
    kb.push(...back);
    return { text: t, kb };
  }

  if (section === "mail") {
    // مشاهده ایمیل‌های یک آدرس (ادمین)
    const addr = arg;
    const rows = await db.prepare("SELECT sender, subject, body, received_at FROM mails WHERE address = ? ORDER BY received_at DESC, id DESC LIMIT 5").bind(addr).all();
    let t = `📥 <b>Admin view:</b> <code>${esc(addr)}</code>\n`;
    if (!rows.results || !rows.results.length) t += "\n📭 ایمیلی نیست.";
    else for (const m of rows.results) {
      const ts = new Date(m.received_at * 1000).toISOString().slice(5, 16).replace("T", " ");
      t += `\n━━━━━━━━\n✉️ ${esc(m.sender || "?")}\n📌 ${esc(m.subject || "")} (${ts})\n${esc((m.body || "").slice(0, 400))}`;
    }
    return { text: t, kb: back };
  }

  if (section === "users") {
    // لیست کاربران
    const rows = await db.prepare(
      "SELECT user_id, COUNT(*) cnt FROM addresses GROUP BY user_id ORDER BY cnt DESC LIMIT 20"
    ).all();
    let t = `👥 <b>کاربران</b> (${rows.results.length})\n\n`;
    const kb = [];
    for (const r of (rows.results || [])) {
      kb.push([{ text: `👤 ${r.user_id} — ${r.cnt} آدرس`, callback_data: `adminuser:${r.user_id}` }]);
    }
    kb.push(...back);
    return { text: t, kb };
  }

  if (section === "recent") {
    const rows = await db.prepare(
      "SELECT address, sender, subject, received_at FROM mails ORDER BY received_at DESC, id DESC LIMIT 10"
    ).all();
    let t = `🆕 <b>آخرین ایمیل‌ها</b>\n\n`;
    for (const r of (rows.results || [])) {
      const ts = new Date(r.received_at * 1000).toISOString().slice(5, 16).replace("T", " ");
      t += `• <code>${esc(r.address)}</code>\n  ← ${esc(r.sender || "?")} — ${esc((r.subject || "").slice(0, 40))} (${ts})\n`;
    }
    return { text: t, kb: back };
  }

  // ---- stats (پیش‌فرض) ----
  const [users, u, mailsToday, mailsTotal] = await Promise.all([
    db.prepare("SELECT COUNT(DISTINCT user_id) c FROM addresses").first(),
    db.prepare("SELECT COUNT(*) c FROM addresses").first(),
    db.prepare("SELECT COUNT(*) c FROM mails WHERE received_at > ?").bind(Math.floor(Date.now() / 1000) - 86400).first(),
    db.prepare("SELECT COUNT(*) c FROM mails").first(),
  ]);
  const domainsLine = DOMAINS.map(d => `  • @${d}`).join("\n");

  return {
    text: `╭─────────────────────\n┃ 🧑‍💼 <b>Admin Panel</b>\n╰─────────────────────\n\n` +
      `👥 <b>کاربران:</b> ${users.c}\n` +
      `📮 <b>آدرس‌ها:</b> ${u.c}\n` +
      `✉️ <b>ایمیل ۲۴ ساعت اخیر:</b> ${mailsToday.c}\n` +
      `📨 <b>کل ایمیل‌ها:</b> ${mailsTotal.c}\n\n` +
      `🌐 <b>دامنه‌های فعال:</b>\n${domainsLine}`,
    kb: [
      [{ text: "👥 کاربران", callback_data: "adminsec:users" }, { text: "🆕 آخرین ایمیل‌ها", callback_data: "adminsec:recent" }],
      [{ text: "🧹 پاکسازی >۷ روز", callback_data: "purge" }, { text: "🔥 پاکسازی کل", callback_data: "purgeall" }],
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

  // /search keyword — جستجو در همه ایمیل‌های کاربر (آیتم ۶)
  if (text.startsWith("/search")) {
    const kw = text.slice(8).trim().toLowerCase();
    if (!kw) return sendMsg(env, chatId, "🔎 چی بگردم؟ مثلاً: <code>/search otp</code> یا <code>/search windscribe</code>");
    const rows = await db.prepare(
      `SELECT m.address, m.sender, m.subject, m.body, m.received_at FROM mails m
       JOIN addresses a ON a.address = m.address
       WHERE a.user_id = ? AND (LOWER(m.subject) LIKE ? OR LOWER(m.body) LIKE ? OR LOWER(m.sender) LIKE ? OR LOWER(m.address) LIKE ?)
       ORDER BY m.received_at DESC LIMIT 10`
    ).bind(userId, `%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`).all();
    if (!rows.results || !rows.results.length) return sendMsg(env, chatId, `🔎 چیزی برای «${esc(kw)}» پیدا نشد.`);
    let t = `🔎 <b>نتایج جستجو:</b> «${esc(kw)}» (${rows.results.length})\n\n`;
    for (const m of rows.results) {
      const ts = new Date(m.received_at * 1000).toISOString().slice(5, 16).replace("T", " ");
      const otp = extractOtp(m.body);
      t += `━━━━━━━━\n📥 <code>${esc(m.address)}</code>\n✉️ ${esc((m.sender || "?").slice(0, 40))}\n📌 ${esc((m.subject || "").slice(0, 60))} (${ts})\n` +
        (otp ? `🔐 <code><b>${otp}</b></code>\n` : "") +
        `${esc((m.body || "").replace(/https?:\/\/\S+/g, "").slice(0, 200))}\n\n`;
    }
    return sendMsg(env, chatId, t.slice(0, 4000));
  }

  // /expire id hours — انقضای خودکار آدرس (آیتم ۸) — 0 = لغو
  if (text.startsWith("/expire")) {
    const m = text.match(/^\/expire\s+(\d+)\s+(\d{1,5})$/);
    if (!m) return sendMsg(env, chatId, "فرمت: <code>/expire آیدی_آدرس ساعت</code>\nمثلاً <code>/expire 3 1</code> = حذف خودکار بعد از ۱ ساعت\n<code>/expire 3 0</code> = لغو انقضا\nآیدی رو از My Email بگیر.");
    const [id, hours] = [parseInt(m[1]), parseInt(m[2])];
    const expires = hours === 0 ? 0 : Math.floor(Date.now() / 1000) + hours * 3600;
    const r = await db.prepare("UPDATE addresses SET expires_at = ? WHERE id = ? AND user_id = ?")
      .bind(expires, id, userId).run();
    if (!r.meta.changes) return sendMsg(env, chatId, "⛔️ آدرس پیدا نشد.");
    return sendMsg(env, chatId, hours === 0
      ? "♾ انقضا لغو شد — آدرس دائمیه."
      : `⏰ آدرس بعد از <b>${hours} ساعت</b> خودکار حذف می‌شه.\nبرای لغو: <code>/expire ${id} 0</code>`);
  }

  // /panel — پنل ادمین (فقط ادمین)
  if (text.startsWith("/panel")) {
    if (!isAdmin(userId)) {
      return sendMsg(env, chatId, "⛔️ این دستور فقط برای مدیر سیستمه.");
    }
    const v = await adminView(db, userId);
    return sendMsg(env, chatId, v.text, v.kb);
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
    const v = await inboxText(db, addr);
    return sendMsg(env, chatId, v.text, inboxKB(addr, v.links));
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
    const res = await tg(env, "editMessageText", {
      chat_id: chatId, message_id: msgId, text, parse_mode: "HTML",
      ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
    });
    // تلگرام وقتی محتوا تغییری نکرده error_code 400 (not modified) می‌ده — رفرش بدون تغییر
    if (res && res.ok === false && /not modified/i.test(res.description || "")) {
      await answer(env, q.id, "✅ چیزی جدید نیست");
    }
    return res;
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
      const v = await inboxText(db, addr, 0);
      return await edit(v.text, inboxKB(addr, v.links, v.otps, v.hasMore, 0));
    }

    if (data.startsWith("inboxpage:")) {
      // inboxpage:address:offset
      const rest = data.slice(10);
      const idx = rest.lastIndexOf(":");
      const addr = rest.slice(0, idx);
      const offset = parseInt(rest.slice(idx + 1)) || 0;
      const own = await db.prepare("SELECT 1 FROM addresses WHERE user_id = ? AND address = ?")
        .bind(userId, addr).first();
      if (!own) { await answer(env, q.id, "⛔️ این آدرس مال شما نیست."); return "ok"; }
      const v = await inboxText(db, addr, offset);
      return await edit(v.text, inboxKB(addr, v.links, v.otps, v.hasMore, offset));
    }

    if (data.startsWith("copyotp:")) {
      const code = data.slice(8);
      // تلگرام اجازه clipboard مستقیم نمی‌ده؛ کد رو به شکل قابل کپی تکی می‌فرستیم
      await answer(env, q.id, `🔐 کد: ${code} — نگه دار، انتخاب و کپی کن`);
      await sendMsg(env, q.message.chat.id, `<code><b>${code}</b></code>`);
      return "ok";
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

    if (data.startsWith("adminsec:")) {
      const v = await adminView(db, userId, data.slice(9));
      return await edit(v.text, v.kb);
    }

    if (data.startsWith("adminuser:")) {
      const v = await adminView(db, userId, "user", data.slice(10));
      return await edit(v.text, v.kb);
    }

    if (data.startsWith("adminmail:")) {
      const v = await adminView(db, userId, "mail", data.slice(10));
      return await edit(v.text, v.kb);
    }

    if (data.startsWith("deluser:")) {
      if (!isAdmin(userId)) { await answer(env, q.id, "⛔️"); return "ok"; }
      const uid = parseInt(data.slice(8));
      const addrs = await db.prepare("SELECT address FROM addresses WHERE user_id = ?").bind(uid).all();
      for (const a of (addrs.results || [])) {
        await db.prepare("DELETE FROM mails WHERE address = ?").bind(a.address).run();
      }
      await db.prepare("DELETE FROM addresses WHERE user_id = ?").bind(uid).run();
      await answer(env, q.id, `🗑 کاربر ${uid} و ${addrs.results.length} آدرسش حذف شد`);
      const v = await adminView(db, userId, "users");
      return await edit(v.text, v.kb);
    }

    if (data === "purgeall") {
      if (!isAdmin(userId)) { await answer(env, q.id, "⛔️ ادمین نیستی"); return "ok"; }
      const r = await db.prepare("DELETE FROM mails").run();
      await answer(env, q.id, `🔥 ${r.meta.changes || 0} ایمیل پاک شد`);
      const v = await adminView(db, userId);
      return await edit(v.text, v.kb);
    }

    if (data === "purge") {
      if (!isAdmin(userId)) { await answer(env, q.id, "⛔️ ادمین نیستی"); return "ok"; }
      const cutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
      const r = await db.prepare("DELETE FROM mails WHERE received_at < ?").bind(cutoff).run();
      await answer(env, q.id, `🧹 ${r.meta.changes || 0} ایمیل قدیمی پاک شد`);
      const v = await adminView(db, userId);
      return await edit(v.text, v.kb);
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

  let to = (message.to || "").toLowerCase();
  let from = "", subject = "", body = "";
  try {
    const raw = await new Response(message.raw).text();
    ({ from, subject, body } = parseEmail(raw));
    subject = (subject || "").slice(0, 300);
  } catch (e) {
    // پارسر کرش کرد — متن خام رو حداقل ذخیره کن تا ایمیل گم نشه
    console.log("parse fail:", e && e.message);
    try {
      const raw = await new Response(message.raw).text();
      const mTo = raw.match(/^To:\s*(.+)$/im); if (mTo && !to) to = mTo[1].toLowerCase();
      const mFr = raw.match(/^From:\s*(.+)$/im); if (mFr) from = mFr[1];
      const mSj = raw.match(/^Subject:\s*(.+)$/im); if (mSj) subject = mSj[1];
      body = raw.slice(0, 3000);
    } catch { body = "(خطای پارس ایمیل)"; }
  }

  try {
    // آدرس‌های ناشناس هم ذخیره می‌شن تا اگر بعداً با /make ساخته شد، ایمیل‌های قبلی دیدنی باشن
    await db.prepare(
      "INSERT INTO mails (address, sender, subject, body, received_at) VALUES (?, ?, ?, ?, ?)"
    ).bind(to, from, subject, body, Math.floor(Date.now() / 1000)).run();
  } catch (e) {
    console.log("DB insert fail:", e && e.message);
    return; // اعلان بی‌معنه اگر ذخیره نشد
  }

  // اعلان فقط به صاحب آدرس (تفکیک کامل) — کد OTP مستقیم توی اعلان (آیتم ۷)
  try {
    const owner = await db.prepare("SELECT user_id FROM addresses WHERE address = ?").bind(to).first();
    if (owner) {
      const otp = extractOtp(body);
      const who = (from || "?").replace(/^"?([^"<]+)"?\s*</, "$1").replace(/<[^>]*>/, "").trim();
      const text = `📩 <b>ایمیل جدید!</b>\n📥 To: <code>${esc(to)}</code>\n✉️ From: ${esc(who.slice(0, 80))}\n📌 Subject: ${(esc(subject.slice(0, 200)) || "(بدون موضوع)")}` +
        (otp ? `\n\n🔐 <b>کد شما:</b> <code><b>${otp}</b></code>` : "");
      const kb = [];
      if (otp) kb.push([{ text: `🔐 کپی کد: ${otp}`, callback_data: `copyotp:${otp}` }]);
      kb.push([{ text: "📥 خواندن", callback_data: `inbox:${to}` }]);
      await tg(env, "sendMessage", {
        chat_id: owner.user_id,
        parse_mode: "HTML",
        text,
        reply_markup: { inline_keyboard: kb },
      });
    }
  } catch (e) { console.log("notify fail:", e && e.message); }
}

// ---------- worker entry ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
      envAdmins = env.ADMIN_IDS || "";

    if (url.pathname === "/health") return new Response("ok");

    // عیب‌یابی: نمای خودِ ورکر از D1 (جدول‌ها + شمارش)
    if (url.pathname === "/dbtest") {
      try {
        await initDB(env.DB);
        const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const m = await env.DB.prepare("SELECT COUNT(*) c FROM mails").first();
        const a = await env.DB.prepare("SELECT COUNT(*) c FROM addresses").first();
        return json({ tables: (t.results || []).map(x => x.name), mails: m.c, addresses: a.c });
      } catch (e) {
        return json({ error: String(e && e.message || e) }, 500);
      }
    }

    // secret check for webhook
    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("method", { status: 405 });
      const upd = await request.json();
      // پاسخ فوری به تلگرام؛ پردازش در بک‌گراند (وگرنه spinner طولانی)
      if (ctx && ctx.waitUntil) ctx.waitUntil(handleUpdate(env, upd).catch(() => {}));
      else await handleUpdate(env, upd);
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

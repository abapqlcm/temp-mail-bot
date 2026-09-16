// تسته محلی worker با mock D1 و Telegram — اجرا: node test.js
const created = [];
function mockDB() {
  const addresses = [], mails = [];
  const run = async (sql, ...binds) => {
    sql = sql.trim();
    if (sql.startsWith("INSERT INTO addresses")) { if (addresses.some(a => a.address === binds[1])) throw new Error("UNIQUE constraint failed: addresses.address"); addresses.push({ id: addresses.length + 1, address: binds[1], user_id: binds[0], label: "", last_used: 0 }); return { meta: { changes: 1 } }; }
    if (sql.startsWith("INSERT INTO mails")) { mails.push({ id: mails.length + 1, address: binds[0], sender: binds[1], subject: binds[2], body: binds[3], received_at: binds[4] }); return { meta: { changes: 1 } }; }
    if (sql.startsWith("UPDATE addresses SET last_used")) return { meta: { changes: 1 } };
    if (sql.startsWith("UPDATE addresses SET label")) { const a = addresses.find(x => x.id === binds[1]); if (a) a.label = binds[0]; return { meta: { changes: a ? 1 : 0 } }; }
    if (sql.startsWith("DELETE FROM addresses")) { const i = addresses.findIndex(x => x.id === binds[0]); if (i >= 0) { mails.length = mails.filter(m => m.address !== addresses[i].address).length; addresses.splice(i, 1); } return { meta: { changes: 1 } }; }
    if (sql.startsWith("DELETE FROM mails")) return { meta: { changes: 0 } };
    if (sql.startsWith("CREATE") || sql.startsWith("ALTER")) return { meta: {} };
    throw new Error("unknown run sql: " + sql);
  };
  const first = async (sql, ...binds) => {
    sql = sql.trim();
    if (sql.includes("COUNT(*) c FROM addresses WHERE user_id")) return { c: addresses.filter(a => a.user_id === binds[0]).length };
    if (sql.includes("COUNT(DISTINCT user_id)")) return { c: new Set(addresses.map(a => a.user_id)).size };
    if (sql.includes("COUNT(*) c FROM addresses")) return { c: addresses.length };
    if (sql.includes("COUNT(*) c FROM mails")) return { c: mails.length };
    if (sql.startsWith("SELECT 1 FROM addresses")) return addresses.find(a => a.user_id === binds[0] && a.address === binds[1]) ? { 1: 1 } : null;
    if (sql.startsWith("SELECT user_id FROM addresses WHERE address")) { const a = addresses.find(x => x.address === binds[0]); return a ? { user_id: a.user_id } : null; }
    if (sql.startsWith("SELECT address FROM addresses WHERE id")) { const a = addresses.find(x => x.id === binds[0] && x.user_id === binds[1]); return a ? { address: a.address } : null; }
    if (sql.startsWith("SELECT address, label")) { const a = addresses.find(x => x.id === binds[0] && x.user_id === binds[1]); return a ? { address: a.address, label: a.label } : null; }
    if (sql.includes("FROM mails WHERE id")) { return mails.find(m => m.id === binds[0]) || null; }
    if (sql.includes("ORDER BY last_used DESC LIMIT 1")) { const list = addresses.filter(a => a.user_id === binds[0]); return list[0] || null; }
    throw new Error("unknown first sql: " + sql);
  };
  const all = async (sql, ...binds) => {
    sql = sql.trim();
    if (sql.includes("FROM addresses WHERE user_id = ? ORDER BY last_used")) return { results: addresses.filter(a => a.user_id === binds[0]).sort((a,b) => b.last_used - a.last_used) };
    if (sql.includes("FROM mails WHERE address")) { const list = mails.filter(m => m.address === binds[0]).slice(0, 10); return { results: list }; }
    if (sql.includes("FROM mails ORDER BY")) return { results: mails.slice(0, 5) };
    throw new Error("unknown all sql: " + sql);
  };
  return { prepare: (sql) => ({ bind: (...b) => ({ run: () => run(sql, ...b), first: () => first(sql, ...b), all: () => all(sql, ...b) }), run: () => run(sql), first: () => first(sql), all: () => all(sql) }) };
}

const sent = [];
const env = {
  BOT_TOKEN: "123:fake",
  MAIL_DOMAIN: "mesterio.life",
  ADMIN_IDS: "999",
  DB: mockDB(),
};
// intercept telegram
const origFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.telegram.org")) {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  }
  return origFetch(url, opts);
};

const _mod = await import("./worker.js");
const worker = _mod.default;
const extractOtp = _mod.extractOtp;
const upd = (o) => ({ request: new Request("https://w.dev/webhook", { method: "POST", body: JSON.stringify(o) }), env });

const assert = (name, cond) => console.log((cond ? "✅" : "❌ FAIL") + " " + name);

// 1. /start
await worker.fetch(upd({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/start" } }).request, env);
assert("start panel", sent.at(-1).text.includes("Temp Mail"));

// 2. domain picker → random on first domain
await worker.fetch(upd({ callback_query: { id: "c0", from: { id: 1 }, data: "dom:new:random", message: { chat: { id: 1 }, message_id: 4 } } }).request, env);
assert("domain picker shown", sent.at(-1).text.includes("دامنه") && JSON.stringify(sent.at(-1)).includes("pick:new:random:mesterio.life"));
await worker.fetch(upd({ callback_query: { id: "c1", from: { id: 1 }, data: "pick:new:random:mesterio.life", message: { chat: { id: 1 }, message_id: 5 } } }).request, env);
assert("random create", sent.at(-1).text.includes("آدرس تصادفی") && sent.at(-1).text.includes("@mesterio.life"));
const addr1 = sent.at(-1).text.match(/<code>([^<]+)<\/code>/)[1];

// 3. custom address on the only domain
await worker.fetch(upd({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/make rez.custom@mesterio.life" } }).request, env);
assert("custom create", sent.at(-1).text.includes("rez.custom@mesterio.life"));

// 4. invalid custom
await worker.fetch(upd({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/make x" } }).request, env);
assert("invalid name rejected", sent.at(-1).text.includes("❌"));

// 5. duplicate
await worker.fetch(upd({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/make rez.custom@mesterio.life" } }).request, env);
assert("duplicate rejected", sent.at(-1).text.includes("قبلاً گرفته شده"));

// 6. myemail lists 2 addresses
await worker.fetch(upd({ callback_query: { id: "c2", from: { id: 1 }, data: "myemail", message: { chat: { id: 1 }, message_id: 6 } } }).request, env);
const meText = JSON.stringify(sent.at(-1));
assert("myemail shows both", meText.includes(addr1) && meText.includes("rez.custom@mesterio.life"));

// 7. inbound email to addr1 → notify owner 1
const emailMsg = { to: addr1, from: "svc@example.com", raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("From: svc@example.com\r\nSubject: OTP 8899\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour code: 8899")); c.close(); } }) };
await worker.email(emailMsg, env);
assert("owner notified", sent.at(-1).chat_id === 1 && sent.at(-1).text.includes("8899"));

// 8. inbound to unknown address → no notify to user 2
sent.length = 0;
await worker.email({ to: "nobody@mesterio.life", raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("Subject: hi\r\n\r\nx")); c.close(); } }) }, env);
assert("unknown dropped silently", sent.length === 0);

// 9. inbox of addr1 shows mail
await worker.fetch(upd({ callback_query: { id: "c3", from: { id: 1 }, data: `inbox:${addr1}`, message: { chat: { id: 1 }, message_id: 7 } } }).request, env);
assert("inbox lists subject", sent.at(-1).text.includes("OTP 8899"));
const mailBtn = JSON.stringify(sent.at(-1)).match(/mail:(\d+):\d+/);
await worker.fetch(upd({ callback_query: { id: "c3b", from: { id: 1 }, data: `mail:${mailBtn[1]}:0`, message: { chat: { id: 1 }, message_id: 7 } } }).request, env);
assert("mail detail shows OTP", sent.at(-1).text.includes("8899"));

// 10. isolation: user2 inbox denied for addr1
await worker.fetch(upd({ callback_query: { id: "c4", from: { id: 2 }, data: `inbox:${addr1}`, message: { chat: { id: 2 }, message_id: 8 } } }).request, env);
assert("isolation enforced", sent.some(s => s.text && s.text.includes("مال شما نیست")));

// 11. rename
await worker.fetch(upd({ message: { chat: { id: 1 }, from: { id: 1 }, text: "/rename 2 myfave" } }).request, env);
assert("rename ok", sent.at(-1).text.includes("✏️"));

// 12. admin panel: owner allowed, stranger denied
await worker.fetch(upd({ callback_query: { id: "c5", from: { id: 999 }, data: "admin", message: { chat: { id: 999 }, message_id: 9 } } }).request, env);
assert("admin ok", sent.at(-1).text && sent.at(-1).text.includes("Admin Panel"));
await worker.fetch(upd({ callback_query: { id: "c6", from: { id: 1 }, data: "admin", message: { chat: { id: 1 }, message_id: 10 } } }).request, env);
assert("admin denied for user", sent.at(-1).text.includes("⛔️"));

// 13. old emails preserved after new creation (myemail still shows both)
await worker.fetch(upd({ callback_query: { id: "c7", from: { id: 1 }, data: "new:random", message: { chat: { id: 1 }, message_id: 11 } } }).request, env);
await worker.fetch(upd({ callback_query: { id: "c8", from: { id: 1 }, data: "myemail", message: { chat: { id: 1 }, message_id: 12 } } }).request, env);
assert("all addresses preserved", JSON.stringify(sent.at(-1)).includes("rez.custom") && JSON.stringify(sent.at(-1)).includes(addr1));

// 14. setwebhook endpoint
const r = await worker.fetch(new Request("https://w.dev/setwebhook"), env);
assert("setwebhook", (await r.json()).ok === true);

// 15. OTP extraction regression — no false positives
const otpCases = [
  ["Your confirmation code is 2096", "2096"],
  ["653340 is your Avast one-time passcode", "653340"],
  ["Order #209612 shipped today", null],
  ["Posted 2024-09-16 at 10:00", null],
  ["کد تایید شما: 482910", "482910"],
  ["Welcome! Nothing to verify", null],
];
for (const [txt, exp] of otpCases) {
  const got = extractOtp(txt);
  assert("otp " + JSON.stringify(txt.slice(0, 28)), got === exp);
}
console.log("\n" + (15 + otpCases.length) + " تست اجرا شد.");

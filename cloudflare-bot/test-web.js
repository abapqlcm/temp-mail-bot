// test-web.js — تست API سایت Aurora Mail
// اجرا: node test-web.js
const WORKER = process.env.WEB_TEST_URL || "https://temp-mail-bot.r65.workers.dev";

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
};
const req = async (path, opts) => {
  const r = await fetch(WORKER + path, opts || {});
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, body: d, headers: r.headers };
};

// ---- mock DB (همان سبک test-mini.js) ----
function makeDb(cols = ["id", "address", "sender", "subject", "body", "raw_snippet", "received_at", "is_read"]) {
  const mails = [
    { id: 1, address: "a@x.com", sender: "GitHub <noreply@github.com>", subject: "Code", body: "your code is 123456", raw_snippet: "", received_at: 1790000000, is_read: 0 },
    { id: 2, address: "a@x.com", sender: "Symlex <no-reply@symlexvpn.org>", subject: "Welcome", body: "hi", raw_snippet: "<h1>Welcome</h1>", received_at: 1790000010, is_read: 1 },
  ];
  const addresses = [{ id: 1, user_id: 100, address: "a@x.com", label: "", created_at: 1, last_used: 1 }];
  const sessions = [{ token: "goodtoken", user_id: 100, created_at: 1, expires_at: 9999999999 }];
  return {
    _mails: mails, _addresses: addresses, _sessions: sessions, _cols: cols,
    prepare(sql) {
      const s = sql.trim().replace(/;$/, "");
      const upper = s.toUpperCase();
      const bind = (...args) => {
        let q = s;
        args.forEach(a => { q = q.replace(/\?/, typeof a === "number" ? String(a) : "'" + String(a).replace(/'/g, "''") + "'"); });
        return {
          async first() {
            if (/SELECT 1 FROM addresses/i.test(q)) {
              const m = q.match(/address = '([^']+)'/);
              return addresses.find(a => a.address === (m && m[1])) ? { "1": 1 } : null;
            }
            if (/FROM sessions/i.test(q)) {
              const m = q.match(/token = '([^']+)'/);
              return sessions.find(s2 => s2.token === (m && m[1])) || null;
            }
            if (/FROM mails/i.test(q) && /WHERE id =/i.test(q)) {
              const m = q.match(/id = (\d+)/);
              return mails.find(m2 => m2.id === Number(m && m[1])) || null;
            }
            if (/FROM mails/i.test(q)) {
              const m = q.match(/address = '([^']+)'/);
              const list = mails.filter(m2 => m2.address === (m && m[1]));
              return { results: list.map(m2 => { const o = {}; cols.forEach(c => o[c] = m2[c]); return o; }) };
            }
            if (/COUNT/i.test(q)) return { c: addresses.length };
            return null;
          },
          async all() {
            if (/FROM addresses/i.test(q) && /user_id =/i.test(q)) {
              return { results: addresses.map(a => Object.assign({}, a, { mail_count: mails.filter(m => m.address === a.address).length, unread: 1, last_mail_at: 1790000010 })) };
            }
            if (/FROM mails/i.test(q)) {
              const m = q.match(/address = '([^']+)'/);
              const list = mails.filter(m2 => m2.address === (m && m[1]));
              return { results: list.map(m2 => { const o = {}; cols.forEach(c => o[c] = m2[c]); return o; }) };
            }
            return { results: [] };
          },
          async run() {
            if (/^INSERT INTO sessions/i.test(q)) {
              const m = q.match(/VALUES \('([^']+)', (\d+),/);
              sessions.push({ token: m && m[1], user_id: Number(m && m[2]), created_at: 1, expires_at: 9999999999 });
            }
            if (/^DELETE FROM sessions/i.test(q)) {
              const m = q.match(/token = '([^']+)'/);
              const i = sessions.findIndex(s2 => s2.token === (m && m[1]));
              if (i >= 0) sessions.splice(i, 1);
            }
            if (/^UPDATE mails/i.test(q)) {
              const m = q.match(/id = (\d+)/);
              const mm = mails.find(m2 => m2.id === Number(m && m[1]));
              if (mm) mm.is_read = 1;
            }
            return {};
          },
        };
      };
      bind.first = bind().first; bind.all = bind().all; bind.run = bind().run;
      return { bind };
    },
  };
}

// ---- handler رو از worker.js استخراج می‌کنیم ----
import fs from "fs";
const src = fs.readFileSync(new URL("./worker.js", import.meta.url), "utf8");

async function main() {
  // توابع کمکی مورد نیاز handleWebApi رو از worker.js بردار
  const helperNames = ["json", "prettySender", "createAddress", "initDB", "DOMAINS", "randLocal"];
  const sandbox = {
    console, fetch: globalThis.fetch, crypto: globalThis.crypto, TextDecoder, atob,
    setTimeout, Date, Math, URL, Response, Headers, Request,
  };
  // INIT_SQL و ALTER_SQLS و توابع initDB
  const INIT_BLOCK = src.slice(src.indexOf("const INIT_SQL"), src.indexOf("// مهاجرت + پاکسازی")) ;
  const HELPER_BLOCK = [
    "function json(o, s){ return new Response(JSON.stringify(o), { status: s||200, headers: { 'Content-Type': 'application/json' } }); }",
    "function prettySender(s){ let t=String(s||'?'); const m=t.match(/^\"?([^\"<]+?)\"?\\s*</); return m?m[1].trim():t.replace(/<[^>]*>/g,'').trim(); }",
    "function esc(s){ return String(s==null?'':s).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])); }",
    "function randLocal(){ return Math.random().toString(36).slice(2,10); }",
    "const DOMAINS = ['mesterio.life'];",
    "const SESSION_MAX_AGE = 2592000;",
    "function randomToken(){ const a=new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a,b=>b.toString(16).padStart(2,'0')).join(''); }",
    "async function getSessionUser(db, request){ const ck=(request.headers.get('Cookie')||''); const m=ck.match(/(?:^|;\\s*)aurora_session=([a-f0-9]{64})/); if(!m) return null; const row=await db.prepare('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?').bind(m[1], Math.floor(Date.now()/1000)).first(); return row?row.user_id:null; }",
    "function sessionCookie(token, maxAge){ return 'aurora_session='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+maxAge; }",
    "let envAdmins = '';",
    "async function initDB(db){ return; }",
  ].join("\n");
  const HANDLER_BLOCK = src.slice(
    src.indexOf("// ---------- web app: API ----------"),
    src.indexOf("// ---------- mini app: API ----------")
  );
  const wrap = INIT_BLOCK + "\n" + HELPER_BLOCK + "\n" + HANDLER_BLOCK + "\nreturn { handleWebApi, initDB };";
  const fn = new Function("sandbox", "fs", wrap);
  const { handleWebApi } = fn(sandbox);

  const mkReq = (path, method = "GET", cookie = "", body) => ({
    method,
    headers: { get: (n) => (n.toLowerCase() === "cookie" ? cookie : null) },
    json: async () => body || {},
  });
  const mkUrl = (path) => new URL("https://x.com" + path);
  const env = { DB: null, ADMIN_IDS: "", MAIL_DOMAIN: "mesterio.life" };

  const call = async (path, method, cookie, body) => {
    env.DB = makeDb();
    const r = await handleWebApi(mkReq(path, method, cookie, body), env, mkUrl(path));
    return { status: r.status, body: JSON.parse(r.headers.get("x-test-body") || "null") };
  };
  // response body رو از طریق یه wrapper بگیر
  const origJson = sandbox.Response;
  const call2 = async (path, method, cookie, body) => {
    if (!env.DB) env.DB = makeDb();
    const r = await handleWebApi(mkReq(path, method, cookie, body), env, mkUrl(path));
    let bd = null;
    try { bd = await r.json(); } catch {}
    return { status: r.status, body: bd, cookie: r.headers.get("Set-Cookie") };
  };

  console.log("\n📡 Web API — " + WORKER);

  console.log("\n1) Unauthenticated access");
  let r = await call2("/web/api/meta", "GET");
  ok("meta without session → 401", r.status === 401, JSON.stringify(r.body));
  r = await call2("/web/api/addresses", "GET");
  ok("addresses without session → 401", r.status === 401);
  r = await call2("/web/api/inbox?addr=a@x.com", "GET");
  ok("inbox without session → 401", r.status === 401);

  console.log("\n2) One-time login token");
  r = await call2("/web/api/start/goodtoken", "GET");
  ok("start token → 200", r.status === 200, JSON.stringify(r.body));
  ok("session cookie set", r.cookie && r.cookie.includes("aurora_session="), r.cookie);
  const sess = (r.cookie || "").match(/aurora_session=([a-f0-9]+)/);
  const CK = "aurora_session=" + (sess ? sess[1] : "x");
  r = await call2("/web/api/start/goodtoken", "GET");
  ok("token is single-use (second try → 401)", r.status === 401);

  console.log("\n3) Authenticated API");
  r = await call2("/web/api/meta", "GET", CK);
  ok("meta with session → 200", r.status === 200 && r.body.domain === "mesterio.life", JSON.stringify(r.body));
  r = await call2("/web/api/addresses", "GET", CK);
  ok("addresses → list", r.status === 200 && r.body.addresses.length === 1, JSON.stringify(r.body));
  ok("unread count present", r.body.addresses[0].unread === 1);
  r = await call2("/web/api/inbox?addr=a@x.com", "GET", CK);
  ok("inbox → 2 mails", r.status === 200 && r.body.mails.length === 2, JSON.stringify(r.body));
  ok("html_snippet served", r.body.mails[1].html_snippet === "<h1>Welcome</h1>");
  r = await call2("/web/api/inbox?addr=other@x.com", "GET", CK);
  ok("cross-user inbox → 403", r.status === 403, JSON.stringify(r.body));

  console.log("\n4) Single mail + mark read");
  r = await call2("/web/api/mail/2", "GET", CK);
  ok("single mail → 200", r.status === 200 && r.body.id === 2, JSON.stringify(r.body));
  r = await call2("/web/api/read/1", "POST", CK);
  ok("mark read → ok", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await call2("/web/api/mail/999", "GET", CK);
  ok("missing mail → 404", r.status === 404);

  console.log("\n5) Delete mail");
  r = await call2("/web/api/mail/2", "DELETE", CK);
  ok("delete → ok", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));

  console.log("\n6) Logout");
  r = await call2("/web/api/logout", "POST", CK);
  ok("logout → ok + cookie cleared", r.status === 200 && (r.cookie || "").includes("Max-Age=0"), JSON.stringify(r.body));

  console.log(`\n${pass + fail} تست: ${pass} ✅ / ${fail} ❌\n`);
  process.exit(fail ? 1 : 0);
}
main().catch(e => { console.error("BOOM:", e.message); process.exit(2); });

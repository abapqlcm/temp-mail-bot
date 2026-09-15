// تست parseEmail با ایمیل‌های واقعی‌نما
const mod = await import("./worker.js");
// parseEmail export نمی‌شه؛ از طریق worker.email و mock D1 تست می‌کنیم
const mails = [];
const addresses = [{ id: 1, address: "test@mesterio.life", user_id: 1 }];
const db = {
  prepare: (sql) => ({ bind: (...b) => ({
    run: async () => {
      const s = sql.trim();
      if (s.startsWith("INSERT INTO mails")) { mails.push({ address: b[0], sender: b[1], subject: b[2], body: b[3], received_at: b[4] }); return { meta: { changes: 1 } }; }
      return { meta: {} };
    },
    first: async () => { const s = sql.trim(); if (s.startsWith("SELECT user_id")) { const a = addresses.find(x => x.address === b[0]); return a ? { user_id: a.user_id } : null; } return null; },
    all: async () => ({ results: [] }),
  }), run: async () => ({ meta: {} }), first: async () => null, all: async () => ({ results: [] }) }),
};

const sent = [];
globalThis.fetch = async (url, opts) => {
  if (String(url).includes("api.telegram.org")) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true })); }
  return fetch(url, opts);
};
const worker = mod.default;
const env = { BOT_TOKEN: "t", MAIL_DOMAIN: "mesterio.life", ADMIN_IDS: "1", DB: db };

// ---- Case 1: multipart/alternative با text/plain + text/html base64 (مثل Windscribe)
const htmlPart = Buffer.from(`<!DOCTYPE html><html><head><style>body{color:#000}</style></head><body><h3>Confirm your email</h3><p>Welcome to <b>Windscribe</b>!</p><p><a href="https://windscribe.com/confirm?token=abc123">Confirm Email Address</a></p><p>Your code: <strong>5544</strong></p></body></html>`).toString("base64");
const raw1 = [
  "From: \"Windscribe\" <noreply@windscribe.com>",
  "To: test@mesterio.life",
  "Subject: Confirm your email address",
  "MIME-Version: 1.0",
  `Content-Type: multipart/alternative; boundary="b1"`,
  "",
  "--b1",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Confirm your email =E2=9C=85",
  "Link: https://windscribe.com/confirm?token=abc123",
  "Code: 5544",
  "--b1",
  "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64",
  "",
  htmlPart,
  "--b1--",
].join("\r\n");

await worker.email({ to: "test@mesterio.life", raw: new Response(raw1).body }, env);
let m = mails.at(-1);
console.log("CASE1 subject:", m.subject);
console.log("CASE1 body:", JSON.stringify(m.body.slice(0, 200)));
console.log(m.body.includes("<!DOCTYPE") ? "❌ CASE1: HTML LEAKED" : "✅ CASE1: no HTML leak");
console.log(m.body.includes("5544") ? "✅ CASE1: code kept" : "❌ CASE1: code lost");
console.log(m.body.includes("windscribe.com/confirm") ? "✅ CASE1: link kept" : "❌ CASE1: link lost");

// ---- Case 2: فقط HTML (بدون plain)، QP-encoded
sent.length = 0;
const raw2 = [
  "From: svc@x.com",
  "To: test@mesterio.life",
  "Subject: =?UTF-8?B?VGVzdCDimLA=?=",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Verify: <a href=\"https://x.com/v?t=1\">click here</a></p><p>OTP 998877</p></body></html>",
].join("\r\n");
await worker.email({ to: "test@mesterio.life", raw: new Response(raw2).body }, env);
m = mails.at(-1);
console.log("\nCASE2 subject:", m.subject);
console.log("CASE2 body:", JSON.stringify(m.body));
console.log(!m.body.includes("<") ? "✅ CASE2: no tags" : "❌ CASE2: tags leaked");
console.log(m.body.includes("998877") && m.body.includes("https://x.com/v?t=1") ? "✅ CASE2: otp+link kept" : "❌ CASE2: content lost");

// ---- Case 3: nested multipart/related containing alternative
sent.length = 0;
const htmlNested = Buffer.from("<html><body><p>Inner OTP 1122</p><a href=\"https://n.io/c\">Confirm</a></body></html>").toString("base64");
const raw3 = [
  "From: n@n.io", "To: test@mesterio.life", "Subject: nested",
  `Content-Type: multipart/mixed; boundary="outer"`, "",
  "--outer",
  `Content-Type: multipart/alternative; boundary="inner"`, "",
  "--inner",
  "Content-Type: text/plain", "", "plain fallback OTP 1122",
  "--inner",
  "Content-Type: text/html", "Content-Transfer-Encoding: base64", "", htmlNested,
  "--inner--",
  "--outer--",
].join("\r\n");
await worker.email({ to: "test@mesterio.life", raw: new Response(raw3).body }, env);
m = mails.at(-1);
console.log("\nCASE3 body:", JSON.stringify(m.body.slice(0, 120)));
console.log(!m.body.includes("<html") && (m.body.includes("1122")) ? "✅ CASE3: nested handled" : "❌ CASE3: nested failed");

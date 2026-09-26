// تست کامل مینی‌اپ: احراز هویت، inbox، single mail، addresses، create، delete
import("./worker.js").then(run).catch(e => { console.log("IMPORT ERR:", e.message); process.exit(1); });

async function run(mod) {
  const worker = mod.default;
  let pass = 0, fail = 0;
  const A = (name, cond) => { console.log((cond ? "✅" : "❌") + " " + name); cond ? pass++ : fail++; };

  // mock D1
  const mails = [];
  const addresses = [];
  const db = {
    prepare: (sql) => {
      const bound = (...b) => ({
        run: async () => {
          const s = sql.trim();
          if (s.startsWith("PRAGMA table_info")) {
            return { results: [
              { name: "id" }, { name: "address" }, { name: "sender" },
              { name: "subject" }, { name: "body" }, { name: "raw_snippet" },
              { name: "received_at" },
            ] };
          }
          if (s.startsWith("INSERT INTO mails")) {
            mails.push({ id: mails.length + 1, address: b[0], sender: b[1], subject: b[2], body: b[3], raw_snippet: b[4], received_at: b[5] });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("INSERT INTO addresses")) {
            if (addresses.some(a => a.address === b[1])) {
              const e = new Error("UNIQUE constraint failed: addresses.address");
              e.message = "UNIQUE constraint failed";
              throw e;
            }
            addresses.push({ id: addresses.length + 1, user_id: b[0], address: b[1], created_at: b[2], last_used: b[3], last_seen: 0, label: "", expires_at: 0 });
            return { meta: { changes: 1 } };
          }
          if (s.startsWith("UPDATE addresses")) { return { meta: { changes: 1 } }; }
          if (s.startsWith("DELETE")) { return { meta: { changes: 1 } }; }
          return { meta: {} };
        },
        first: async () => {
          const s = sql.trim();
          if (/SELECT 1 FROM addresses WHERE user_id/.test(s)) {
            return addresses.some(a => a.user_id === b[0] && a.address === b[1]) ? { "1": 1 } : null;
          }
          if (/SELECT COUNT/.test(s) && s.includes("addresses")) {
            return { c: addresses.filter(a => a.user_id === b[0]).length };
          }
          if (/SELECT address FROM addresses WHERE id/.test(s)) {
            const a = addresses.find(x => x.id === b[0] && x.user_id === b[1]);
            return a ? { address: a.address } : null;
          }
          if (s.startsWith("SELECT id, address, sender, subject, body, raw_snippet, received_at FROM mails WHERE id")) {
            return mails.find(m => m.id === b[0]) || null;
          }
          return null;
        },
        all: async () => {
          const s = sql.trim();
          if (s.startsWith("SELECT address FROM addresses WHERE user_id")) {
            return { results: addresses.filter(a => a.user_id === b[0]).map(a => ({ address: a.address })) };
          }
          if (/SELECT a\.id/.test(s)) {
            // addresses list با mail_count — GROUP BY a.id؛ bind اول user_id
            return { results: addresses.filter(a => a.user_id === b[0]).map(a => ({ ...a, mail_count: 0, last_mail_at: 0 })) };
          }
          if (s.startsWith("SELECT id, address, sender, subject, body, received_at")) {
            // inbox همه: WHERE address IN (?,?,?) — bind‌ها همه آدرس هستن
            // inbox یک آدرس: WHERE address = ? — bind اول آدرسه
            if (/WHERE address IN/.test(s)) {
              return { results: mails.filter(m => b.includes(m.address)) };
            }
            if (/WHERE address = /.test(s)) {
              return { results: mails.filter(m => m.address === b[0]) };
            }
            return { results: mails };
          }
          return { results: [] };
        },
      });
      // D1: prepare(sql).run() بدون bind هم معتبره
      return { bind: bound, run: () => bound().run(), first: () => bound().first(), all: () => bound().all() };
    },
    batch: async (stmts) => { for (const st of stmts) await st.run(); return []; },
  };

  const env = {
    BOT_TOKEN: "123:FAKE_TOKEN_FOR_TEST",
    MAIL_DOMAIN: "mesterio.life",
    ADMIN_IDS: "1",
    DB: db,
    MINI_DEV_UID: "1", // حالت توسعه: احراز هویت real لازم نیست
  };

  const req = (path, opts = {}) =>
    new Request("https://w.dev/mini" + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

  // ================= ۱. احراز هویت =================
  // بدون initData و بدون DEV_UID → 401
  {
    const envNoDev = { ...env, MINI_DEV_UID: "" };
    const res = await worker.fetch(req("/meta"), envNoDev, {});
    A("unauthenticated → 401", res.status === 401);
  }

  // با DEV_UID → 200
  {
    const res = await worker.fetch(req("/meta"), env, {});
    const j = await res.json();
    A("dev auth → meta ok", res.status === 200 && j.domain === "mesterio.life");
  }

  // ================= ۲. inbox خالی =================
  {
    const res = await worker.fetch(req("/inbox"), env, {});
    const j = await res.json();
    A("empty inbox", res.status === 200 && Array.isArray(j.mails) && j.mails.length === 0);
  }

  // ================= ۳. ساخت آدرس =================
  let createdAddr;
  {
    const res = await worker.fetch(req("/address", { method: "POST", body: { name: "testbox" } }), env, {});
    const j = await res.json();
    createdAddr = j.address;
    A("create address", res.status === 200 && createdAddr === "testbox@mesterio.life");
  }
  // نام تکراری
  {
    const res = await worker.fetch(req("/address", { method: "POST", body: { name: "testbox" } }), env, {});
    const j = await res.json();
    A("duplicate rejected", res.status === 400 && !!j.error);
  }
  // نام نامعتبر
  {
    const res = await worker.fetch(req("/address", { method: "POST", body: { name: "ab" } }), env, {});
    A("short name rejected", res.status === 400);
  }

  // ================= ۴. ایمیل ورودی (HTML گرافیکی) =================
  const htmlEmail = [
    "From: Newsletter <news@symlexvpn.org>",
    "To: testbox@mesterio.life",
    "Subject: Verify Your Account",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    "verify at https://x.io/c",
    "--b",
    "Content-Type: text/html; charset=UTF-8",
    "",
    "<html><body><h1>Welcome!</h1><p>Click <a href='https://x.io/c'>here</a> to verify.</p></body></html>",
    "--b--",
  ].join("\r\n");
  await worker.email(
    { to: "testbox@mesterio.life", raw: new Response(htmlEmail).body },
    env
  );
  A("email stored", mails.length === 1);

  // ================= ۵. inbox ایمیل دار =================
  {
    const res = await worker.fetch(req("/inbox"), env, {});
    const j = await res.json();
    A("inbox has mail", j.mails.length === 1);
    A("sender cleaned", j.mails[0].sender === "Newsletter");
    A("html_snippet saved", !!j.mails[0].html_snippet);
    A("html_snippet has script stripped", !/script/i.test(j.mails[0].html_snippet));
    A("html_snippet has h1", /Welcome!/.test(j.mails[0].html_snippet));
  }

  // ================= ۶. single mail =================
  {
    const mailId = mails[0].id;
    const res = await worker.fetch(req("/mail/" + mailId), env, {});
    const j = await res.json();
    A("mail detail ok", res.status === 200 && j.subject === "Verify Your Account");
    A("mail has html_snippet", !!j.html_snippet);
  }
  // mail متعلق به کاربر دیگه → 403
  {
    const envOther = { ...env, MINI_DEV_UID: "999" };
    const res = await worker.fetch(req("/mail/" + mails[0].id), envOther, {});
    A("other user mail → 403", res.status === 403);
  }

  // ================= ۷. addresses list =================
  {
    const res = await worker.fetch(req("/addresses"), env, {});
    const j = await res.json();
    A("addresses listed", j.addresses.length === 1 && j.addresses[0].address === "testbox@mesterio.life");
  }

  // ================= ۸. inbox فیلتر بر اساس آدرس =================
  {
    const res = await worker.fetch(req("/inbox?addr=testbox@mesterio.life"), env, {});
    const j = await res.json();
    A("filtered inbox", j.mails.length === 1 && j.active === "testbox@mesterio.life");
  }
  // آدرس متعلق به کاربر دیگه → 403
  {
    const envOther = { ...env, MINI_DEV_UID: "999" };
    const res = await worker.fetch(req("/inbox?addr=testbox@mesterio.life"), envOther, {});
    A("other user addr → 403", res.status === 403);
  }

  // ================= ۹. delete address =================
  {
    const res = await worker.fetch(req("/address/1", { method: "DELETE" }), env, {});
    A("delete address", res.status === 200 && (await res.json()).ok === true);
  }

  // ================= ۱۰. HTML سرو =================
  {
    const res = await worker.fetch(new Request("https://w.dev/mini"), env, {});
    const html = await res.text();
    A("mini html served", res.status === 200 && html.includes("Aurora Mail"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

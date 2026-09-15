import os, json, time, sqlite3, hashlib, hmac
import requests
from flask import Flask, request, jsonify

BOT_TOKEN = os.environ["BOT_TOKEN"]
BOT_SECRET = os.environ.get("WORKER_SECRET", "changeme")
DOMAIN = os.environ.get("MAIL_DOMAIN", "example.com")
ADMIN_ID = int(os.environ.get("ADMIN_ID", "0"))
MAX_ADDRS = int(os.environ.get("MAX_ADDRS_PER_USER", "10"))
DB_PATH = os.environ.get("DB_PATH", "/data/mailbot.db")

app = Flask(__name__)
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.execute("""CREATE TABLE IF NOT EXISTS addresses(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER, address TEXT UNIQUE, created_at INTEGER)""")
db.execute("""CREATE TABLE IF NOT EXISTS mails(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT, sender TEXT, subject TEXT, body TEXT, received_at INTEGER)""")
db.execute("CREATE INDEX IF NOT EXISTS idx_addr ON addresses(user_id)")
db.execute("CREATE INDEX IF NOT EXISTS idx_mails ON mails(address)")
db.commit()

def api(method, **kw):
    r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}", json=kw, timeout=20)
    return r.json()

def esc(t):
    return (t or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def send(chat_id, text, kb=None):
    payload = dict(chat_id=chat_id, text=text, parse_mode="HTML")
    if kb:
        payload["reply_markup"] = {"inline_keyboard": kb}
    return api("sendMessage", **payload)

def count_addrs(uid):
    return db.execute("SELECT COUNT(*) FROM addresses WHERE user_id=?", (uid,)).fetchone()[0]

def list_addrs(uid):
    return [r[0] for r in db.execute(
        "SELECT address FROM addresses WHERE user_id=? ORDER BY id DESC", (uid,))]

def new_address(uid, local=None):
    if local:
        if not (3 <= len(local) <= 30) or not local.replace(".", "").replace("_", "").replace("-", "").isalnum():
            return None, "اسم باید ۳ تا ۳۰ کاراکتر و فقط حرف/عدد/._- باشه."
    else:
        local = hashlib.sha1(f"{uid}{time.time()}".encode()).hexdigest()[:8]
    addr = f"{local}@{DOMAIN}"
    try:
        db.execute("INSERT INTO addresses(user_id,address,created_at) VALUES(?,?,?)",
                   (uid, addr, int(time.time())))
        db.commit()
    except sqlite3.IntegrityError:
        return None, "این آدرس قبلاً گرفته شده، یه اسم دیگه امتحان کن."
    return addr, None

# ---------- Telegram webhook ----------
@app.route("/webhook", methods=["POST"])
def webhook():
    upd = request.get_json(force=True)
    if "callback_query" in upd:
        return handle_callback(upd["callback_query"])
    msg = upd.get("message") or upd.get("edited_message") or {}
    chat = (msg.get("chat") or {}).get("id")
    uid = (msg.get("from") or {}).get("id")
    text = (msg.get("text") or "").strip()
    if not chat or not uid:
        return "ok"
    if text.startswith("/start"):
        send(chat, f"📬 <b>Temp Mail Bot</b>\nدامنه: <code>@{DOMAIN}</code>\n\n"
                   "/new — آدرس تصادفی بساز\n/make name — آدرس دلخواه بساز\n"
                   "/list — لیست آدرس‌هات\n/inbox — آخرین ایمیل‌ها\n/del — پاک کردن همه آدرس‌هات")
    elif text.startswith("/new"):
        if count_addrs(uid) >= MAX_ADDRS:
            send(chat, f"محدودیت {MAX_ADDRS} آدرس پر شده. اول با /del پاک کن.")
        else:
            addr, err = new_address(uid)
            send(chat, f"✅ <code>{esc(addr or err)}</code>" if not err else f"❌ {err}")
    elif text.startswith("/make "):
        if count_addrs(uid) >= MAX_ADDRS:
            send(chat, f"محدودیت {MAX_ADDRS} آدرس پر شده. اول با /del پاک کن.")
        else:
            local = text[6:].strip().lower().split("@")[0]
            addr, err = new_address(uid, local)
            if err:
                send(chat, f"❌ {err}")
            else:
                send(chat, f"✅ آدرس جدید:\n<code>{esc(addr)}</code>")
    elif text.startswith("/list"):
        addrs = list_addrs(uid)
        if not addrs:
            send(chat, "آدرسی نداری. با /new بساز.")
        else:
            kb = [[{"text": a, "callback_data": f"inbox:{a}"}] for a in addrs]
            send(chat, "📇 آدرس‌هات — روی هرکدوم بزن تا اینباکسش بیاد:", kb)
    elif text.startswith("/inbox"):
        addrs = list_addrs(uid)
        if not addrs:
            send(chat, "آدرسی نداری.")
        elif len(addrs) == 1:
            a = addrs[0]
            send(chat, inbox_text(a), [[{"text": "🔄 تازه‌سازی", "callback_data": f"inbox:{a}"}]])
        else:
            kb = [[{"text": a, "callback_data": f"inbox:{a}"}] for a in addrs]
            send(chat, "کدوم آدرس؟", kb)
    elif text.startswith("/del"):
        db.execute("DELETE FROM addresses WHERE user_id=?", (uid,))
        db.commit()
        send(chat, "🗑 همه آدرس‌هات پاک شد (ایمیل‌های قدیمی هم دیگه نشون داده نمی‌شن).")
    else:
        send(chat, "دستور نامفهوم. /start رو بزن.")
    return "ok"

def inbox_text(addr):
    rows = db.execute(
        "SELECT sender,subject,body,received_at FROM mails WHERE address=? ORDER BY id DESC LIMIT 10",
        (addr,)).fetchall()
    if not rows:
        return f"📭 <code>{esc(addr)}</code>\nهنوز ایمیلی نرسیده."
    out = [f"📥 <b>اینباکس</b> <code>{esc(addr)}</code>"]
    for s, subj, body, ts in rows:
        out.append(f"\n✉️ <b>از:</b> {esc(s)}\n<b>موضوع:</b> {esc(subj) or '(بدون موضوع)'}\n"
                   f"⏰ {time.strftime('%Y-%m-%d %H:%M', time.gmtime(ts))} UTC\n"
                   f"<pre>{esc((body or '')[:1500])}</pre>")
    return "\n".join(out)

@app.route("/callback", methods=["POST"])
def callback():
    q = request.get_json(force=True).get("callback_query")
    if q:
        handle_callback(q)
    return "ok"

def handle_callback(q):
    data = q.get("data") or ""
    msg = q.get("message") or {}
    if data.startswith("inbox:"):
        addr = data[6:]
        if addr not in list_addrs(q.get("from", {}).get("id", 0)):
            api("answerCallbackQuery", callback_query_id=q.get("id"))
            return "ok"
        api("editMessageText", chat_id=msg["chat"]["id"], message_id=msg["message_id"],
            text=inbox_text(addr), parse_mode="HTML",
            reply_markup={"inline_keyboard": [[{"text": "🔄 تازه‌سازی", "callback_data": f"inbox:{addr}"}]]})
    api("answerCallbackQuery", callback_query_id=q.get("id"))
    return "ok"

# ---------- Cloudflare Email Worker endpoint ----------
@app.route("/inbound", methods=["POST"])
def inbound():
    if request.headers.get("X-Worker-Secret") != BOT_SECRET:
        return jsonify({"error": "unauthorized"}), 401
    d = request.get_json(force=True)
    to = (d.get("to") or "").lower()
    addr_row = db.execute("SELECT user_id FROM addresses WHERE address=?", (to,)).fetchone()
    # ایمیل به آدرس‌های ثبت‌شده تحویل می‌شه؛ آدرس‌های ناشناس هم ذخیره می‌شن تا بعد از /make دیده بشن؟ نه — فقط ثبت‌شده‌ها
    if not addr_row:
        return jsonify({"ok": True, "dropped": True})
    db.execute("INSERT INTO mails(address,sender,subject,body,received_at) VALUES(?,?,?,?,?)",
               (to, d.get("from", "?"), d.get("subject", ""), d.get("body", ""), int(time.time())))
    db.commit()
    uid = addr_row[0]
    send(uid, f"📩 ایمیل جدید به <code>{esc(to)}</code>\n"
              f"✉️ از: {esc(d.get('from','?'))}\nموضوع: {esc(d.get('subject',''))}")
    return jsonify({"ok": True})

@app.route("/health")
def health():
    return "ok"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))

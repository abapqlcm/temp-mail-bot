# 📬 Temp Mail Bot — Cloudflare All-in-One

ربات تلگرامی ایمیل موقت روی دامنه‌های اختصاصی خودت — **کاملاً داخل Cloudflare Worker**، بدون Railway، بدون سرور، بدون هزینه.

## ✨ امکانات

### 🎛 پنل تلگرامی
| بخش | توضیح |
|---|---|
| 🎲 **Random** | انتخاب دامنه → آدرس تصادفی |
| ✏️ **Custom** | انتخاب دامنه → `/make name@domain` — آدرس با اسم دلخواه |
| 📬 **My Email** | لیست همه آدرس‌های کاربر + سوییچ آزاد بین‌شون — **هیچ آدرسی از دست نمی‌ره** |
| ✏️ **Rename** | اسم نمایشی دلخواه برای هر آدرس |
| 🗑 **Delete** | حذف آدرس و ایمیل‌هاش |
| 🧑‍💼 **Admin** | آمار کل سیستم (کاربران/آدرس‌ها/ایمیل‌ها) + پاکسازی ایمیل‌های قدیمی |

### 📥 اینباکس هوشمند
- 🔔 **اعلان لحظه‌ای** وقتی ایمیل جدید می‌رسه
- 🧹 **متن تمیز**: HTML و base64 و quoted-printable به متن ساده تبدیل می‌شه
- 🔘 **دکمه‌های تپ مستقیم**: لینک‌های تأیید/ریست/لاگین به دکمه تبدیل می‌شن — **بدون کپی کردن، با یه تپ باز می‌شن**
  - ✅ Confirm / 🔑 Reset / 🔓 Login / ⭐️ Upgrade — لیبل خودکار بر اساس نوع لینک
  - ایمیلی که فقط کد OTP داره → هیچ دکمه‌ای نمیاد، فقط متن
- 🔒 **تفکیک کامل**: ایمیل هر آدرس فقط به صاحبش می‌رسه

### 🌐 چند-دامنه‌ای
- پشتیبانی از چند دامنه روی یک ربات (`DOMAINS` در وورکر)
- کاربر موقع ساخت، دامنه رو خودش انتخاب می‌کنه

## 🏗 معماری
```
Telegram ◀──webhook──▶  Cloudflare Worker  ◀──Email Routing── ایمیل ورودی *@دامنه
                          │
                    D1 Database (رایگان)
```
- همه‌چیز در **یک Worker**: ربات + دریافت ایمیل + دیتابیس
- صفر هزینه، بدون sleep، بدون سرور

## 🚀 دیپلوی (۱۰ دقیقه)

```bash
cd cloudflare-bot
npm install -g wrangler
wrangler login

# 1. دامنه‌هات رو در worker.js تنظیم کن
#    const DOMAINS = ["mesterio.life", "example.com"];

# 2. ساخت دیتابیس D1
wrangler d1 create tempmail
# → database_id و account_id رو در wrangler.toml بذار

# 3. ساخت جداول
wrangler d1 execute tempmail --file schema.sql --remote

# 4. ADMIN_IDS در wrangler.toml (آیدی عددی تلگرام — با /id از ربات بگیر)

# 5. توکن ربات
wrangler secret put BOT_TOKEN

# 6. دیپلوی
wrangler deploy

# 7. ست کردن webhook
curl "https://<worker-name>.<subdomain>.workers.dev/setwebhook"
```

### اتصال دامنه‌ها (Cloudflare Email Routing)
برای هر دامنه:
1. داشبورد Cloudflare → دامنه → **Email → Email Routing** → فعال کن (MX خودکار ست می‌شه)
2. **Routing rules → Catch-all** → Action: **Send to Worker** → `temp-mail-bot`

حالا هر ایمیلی به `هرچیزی@دامنه` مستقیم به ربات می‌رسه ✅

## 🤖 دستورات ربات
| دستور | کار |
|---|---|
| `/start` | باز کردن پنل |
| `/new` | ساخت آدرس (با انتخاب دامنه) |
| `/make name@domain` | آدرس دلخواه با دامنه مشخص |
| `/inbox` | اینباکس آخرین آدرس |
| `/rename id newname` | تغییر اسم نمایشی |
| `/id` | دیدن آیدی عددی تلگرام |

## 🧪 تست
```bash
node test.js        # ۱۶ تست پنل و جریان‌ها
node test-parse.js  # ۷ تست پارسر ایمیل (multipart/base64/QP/HTML)
```

## 📁 ساختار
```
cloudflare-bot/
├── worker.js       # کل ربات + پارسر ایمیل (یک فایل!)
├── wrangler.toml   # کانفیگ دیپلوی
├── schema.sql      # جداول D1
├── test.js         # تست‌های پنل
└── test-parse.js   # تست‌های پارسر
```

## 🔒 امنیت و حریم خصوصی
- ایمیل هر آدرس فقط به صاحبش می‌رسه (چک ownership در هر درخواست)
- توکن ربات به صورت Cloudflare Secret
- پنل ادمین فقط برای `ADMIN_IDS`

## 💡 نکات
- محدودیت رایگان Cloudflare: 100k request/day، 1000 email/day — برای استفاده شخصی خیلی کافیه
- پارس HTML: لینک‌های مهم به دکمه تبدیل و از متن حذف می‌شن؛ متن ایمیل خوانا و تمیز می‌مونه
- ایمیل‌های آدرس‌های ثبت‌نشده هم ذخیره می‌شن — اگر بعداً اون آدرس با Custom ساخته بشه، میل‌باکسش از اول پرِ ایمیل هست
- پاکسازی دستی ایمیل‌های قدیمی از پنل ادمین (🧹 Purge — قدیمی‌تر از ۷ روز)

## 📜 License
MIT

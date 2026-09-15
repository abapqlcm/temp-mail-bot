# 📬 Temp Mail Bot — Cloudflare All-in-One

ربات تلگرامی ایمیل موقت روی دامنه اختصاصی خودت — **کاملاً داخل Cloudflare Worker**، بدون Railway، بدون سرور، بدون هزینه.

## معماری
```
Telegram ◀──webhook──▶  Cloudflare Worker  ◀──Email Routing── ایمیل ورودی به *@دامنه
                          │
                        D1 Database (رایگان)
```
- ✅ ربات تلگرام + دریافت ایمیل + دیتابیس همه در **یک Worker**
- ✅ Telegram API از داخل Worker مستقیم صدا زده می‌شه (fetch خارجی رایگان تا ۱۰۰k req/day)

## امکانات پنل
| بخش | توضیح |
|---|---|
| 🎲 Random | ساخت آدرس تصادفی |
| ✏️ Custom | `/make name` — آدرس با اسم دلخواه |
| 📬 My Email | لیست همه آدرس‌های کاربر + سوییچ بین‌شون — **هیچ آدرسی از دست نمی‌ره** |
| 📥 Inbox | آخرین ۱۰ ایمیل هر آدرس + اعلان لحظه‌ای ایمیل جدید |
| ✏️ Rename | اسم نمایشی دلخواه برای هر آدرس (`/rename id newname`) |
| 🗑 Delete | حذف آدرس و ایمیل‌هاش |
| 🧑‍💼 Admin | آمار کل سیستم + پاکسازی ایمیل‌های قدیمی (فقط ADMIN_IDS) |

🔒 **تفکیک کامل:** ایمیل هر آدرس فقط به صاحبش می‌رسه و هر کاربر فقط اینباکس آدرس‌های خودش رو می‌بینه.

## دیپلوی (۱۰ دقیقه)
```bash
cd cloudflare-bot
npm install -g wrangler
wrangler login

# 1. ساخت دیتابیس D1
wrangler d1 create tempmail
# → database_id رو کپی کن توی wrangler.toml

# 2. ساخت جداول
wrangler d1 execute tempmail --file schema.sql --remote

# 3. تنظیم متغیرها در wrangler.toml → [vars]
#    MAIL_DOMAIN = "mail.yourdomain.com"
#    ADMIN_IDS   = "Telegram user id خودت (با /id از ربات بگیر)"

# 4. توکن ربات (secret)
wrangler secret put BOT_TOKEN

# 5. دیپلوی
wrangler deploy

# 6. ست کردن webhook
curl "https://temp-mail-bot.<your-subdomain>.workers.dev/setwebhook"
```

## اتصال دامنه (Cloudflare Email Routing)
1. داشبورد Cloudflare → دامنه‌ات → **Email → Email Routing** → فعال کن
2. تب **Email Workers** → **Create** → این Worker رو به عنوان handler انتخاب کن (یا route اضافه کن)
3. **Routing rules → Catch-all** → Action: Send to Worker → همون worker
4. حالا هر ایمیلی به `هرچیزی@دامنه` مستقیم به ربات می‌رسه ✅

## تست
```bash
node test.js   # ۱۴ تست — همه پاس
```

## نکات
- ایمیل‌های HTML به متن ساده تبدیل می‌شن (base64/quoted-printable decode می‌شن)
- ایمیل‌های آدرس‌های ثبت‌نشده ذخیره می‌شن؛ اگر بعداً اون آدرس با Custom ساخته شه، میل‌باکسش از اول پر هست
- محدودیت رایگان Cloudflare: 100k request/day، 1000 email/day — برای بات شخصی خیلی بیش از کافیه

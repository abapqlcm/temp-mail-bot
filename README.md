# 📬 Temp Mail Bot

ربات تلگرامی ایمیل موقت روی دامنه اختصاصی خودت (Cloudflare Email Routing + Railway).

## امکانات
- `/new` — ساخت آدرس تصادفی
- `/make name` — ساخت آدرس با اسم دلخواه (`name@damene.ir`)
- `/list` — لیست آدرس‌ها با دکمه اینباکس
- `/inbox` — آخرین ۱۰ ایمیل هر آدرس + اعلان لحظه‌ای ایمیل جدید
- `/del` — پاک کردن همه آدرس‌ها
- محدودیت تعداد آدرس per user (پیش‌فرض ۱۰)

## معماری
```
Telegram ──webhook──▶ Railway (Flask bot) ◀──POST /inbound── Cloudflare Email Worker
                              │
                            SQLite (/data volume)
```

## دیپلوی Railway
1. Repo رو به Railway وصل کن (Dockerfile خودکار بیلد می‌شه)
2. Volume بده به `/data`
3. متغیرها:
   - `BOT_TOKEN` — توکن ربات از @BotFather
   - `WORKER_SECRET` — یک رشته رمز تصادفی (بین وورکر و ربات)
   - `MAIL_DOMAIN` — دامنه‌ات مثل `mail.yourdomain.com`
   - `ADMIN_ID` — آیدی عددی خودت (اختیاری)
4. Webhook ست کن: `https://<railway-app>/webhook` را با setWebhook به تلگرام بده (طلبه /upwebhook endpoint و /callback هر دو روی همین URL هستن؛ تلگرام فقط /webhook رو set می‌کنی و callback خودکار از طریق update میاد — در این کد هر دو endpoint جدا هستند، پس setWebhook را روی /webhook بزن و callback_query ها هم به همان /webhook می‌رسند؛ endpoint /callback برای سازگاری است).

> نکته: کد callback_query ها را در همان /webhook هندل نمی‌کند؛ اگر دکمه‌ها کار نکردند setWebhook را روی یک route مشترک بزن یا /callback را جدا set کن. (در نسخه فعلی callback ها از طریق /callback هندل می‌شوند — تلگرام اجازه فقط یک webhook می‌دهد، پس بهتر است این دو ادغام شوند.)

## Cloudflare Email Worker
1. فایل `cloudflare-worker.js` را به عنوان Email Worker در Cloudflare دیپلوی کن (wrangler یا داشبورد → Email → Email Workers)
2. متغیرها (wrangler vars یا dashboard):
   - `BOT_URL` — آدرس Railway، مثل `https://temp-mail-bot.up.railway.app`
   - `WORKER_SECRET` — همان رمز بالا
3. در Email Routing دامنه: یک Catch-all rule بساز که به این worker بفرستد
4. MX و SPF دیگه لازم نیست تنظیم کنی — Email Routing خودش هندل می‌کند

## نکات
- ایمیل‌های HTML به صورت text ساده (بدون فرمت) نمایش داده می‌شوند
- کدهای تأیید (OTP) در متن ایمیل قابل کپی هستند
- ایمیل‌های قدیمی در SQLite می‌مانند — برای پاکسازی دوره‌ای، حجم volume را زیر نظر داشته باش

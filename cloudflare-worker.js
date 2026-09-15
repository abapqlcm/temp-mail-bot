export default {
  async email(message, env, ctx) {
    // خواندن متن ایمیل خام و استخراج ساده
    const raw = await new Response(message.raw).text();

    const getHeader = (name) => {
      const m = raw.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
      return m ? m[1].trim() : "";
    };

    // استخراج بدنه ساده (بخش text/plain یا fallback کل بدنه)
    let body = "";
    const parts = raw.split(/\r?\n\r?\n/);
    const plainMatch = raw.match(/Content-Type: text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\s*$)/i);
    if (plainMatch) body = plainMatch[1];
    else if (parts.length > 1) body = parts.slice(1).join("\n\n");
    body = body.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi,
      (_, h) => String.fromCharCode(parseInt(h, 16))).trim().slice(0, 4000);

    const payload = {
      to: message.to.toLowerCase(),
      from: getHeader("From") || message.from,
      subject: getHeader("Subject"),
      body,
    };

    await fetch(`${env.BOT_URL}/inbound`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Worker-Secret": env.WORKER_SECRET },
      body: JSON.stringify(payload),
    });
  },
};

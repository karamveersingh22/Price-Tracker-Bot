import dbConnect from "@/lib/dbConnect";
import Product from "@/models/Product";
import { getPrice, getProductInfo } from "@/lib/tracker";
import TelegramBot from "node-telegram-bot-api";

export async function POST(request) {
  const secret = request.headers.get("x-check-secret") || "";
  // Accept either server-only secret or public one used by dashboard
  if (secret !== process.env.CHECK_SECRET && secret !== process.env.NEXT_PUBLIC_CHECK_SECRET)
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
    });

  const uri = process.env.MONGODB_URI;
  await dbConnect(uri);
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const bot = new TelegramBot(botToken, { polling: false });

  const products = await Product.find({});
  const results = [];
  for (const p of products) {
    const newPrice = await getPrice(p.url);
    if (newPrice == null) continue;
    if (p.lastPrice == null) {
      p.lastPrice = newPrice;
      p.lastCheckedAt = new Date();
      await p.save();
      results.push({ url: p.url, status: 'initialized', price: newPrice });
      continue;
    }
    if (newPrice !== p.lastPrice) {
      // Best-effort: refresh title when notifying
      if (!p.title) {
        try {
          const info = await getProductInfo(p.url);
          if (info.title) p.title = info.title;
        } catch {}
      }
      // send message
      if (p.chatId) {
        const label = p.title ? `${p.title}\n${p.url}` : p.url;
        const text =
          newPrice > p.lastPrice
            ? `⚠️ Price increased!\n${label}\nOld: ${p.lastPrice}\nNow: ${newPrice}`
            : `✅ Price dropped!\n${label}\nOld: ${p.lastPrice}\nNow: ${newPrice}`;
        try {
          await bot.sendMessage(p.chatId.toString(), text);
        } catch (e) {
          console.error("tg send failed", e.message);
        }
      }
      results.push({ url: p.url, status: 'changed', old: p.lastPrice, new: newPrice });
      p.lastPrice = newPrice;
      p.lastCheckedAt = new Date();
      await p.save();
    } else {
      p.lastCheckedAt = new Date();
      await p.save();
      results.push({ url: p.url, status: 'no-change', price: p.lastPrice });
    }
  }

  return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
}

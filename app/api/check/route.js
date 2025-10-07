import dbConnect from "@/lib/dbConnect";
import Product from "@/models/Product";
import ChatSettings from "@/models/ChatSettings";
import { getPrice, getProductInfo } from "@/lib/tracker";
import { sendMessage } from "@/lib/telegram";

async function handleCheck(request) {
  const url = new URL(request.url);
  const qpSecret = url.searchParams.get("secret") || "";
  const headerSecret = request.headers.get("x-check-secret") || "";
  const secret = headerSecret || qpSecret;
  // Accept either server-only secret or public one used by dashboard (in dev). Prefer CHECK_SECRET in prod.
  if (secret !== process.env.CHECK_SECRET && secret !== process.env.NEXT_PUBLIC_CHECK_SECRET) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const uri = process.env.MONGODB_URI;
  await dbConnect(uri);

  const products = await Product.find({});
  const results = [];
  for (const p of products) {
    // Respect per-chat frequency via ChatSettings
    let intervalMinutes = 1; // default
    if (p.chatId) {
      try {
        const s = await ChatSettings.findOne({ chatId: String(p.chatId) }).lean();
        if (s && Number.isFinite(s.intervalMinutes)) intervalMinutes = s.intervalMinutes;
      } catch {}
    }
    if (p.lastCheckedAt) {
      const msSince = Date.now() - new Date(p.lastCheckedAt).getTime();
      const needMs = intervalMinutes * 60 * 1000;
      if (msSince < needMs) {
        results.push({ url: p.url, status: 'skipped', reason: `next check in ${Math.ceil((needMs - msSince)/1000)}s` });
        continue;
      }
    }

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
          await sendMessage(p.chatId.toString(), text);
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

export async function POST(request) {
  return handleCheck(request);
}

export async function GET(request) {
  return handleCheck(request);
}

import dbConnect from "@/lib/dbConnect";
import Product from "@/models/Product";
import ChatSettings from "@/models/ChatSettings";
import { getPrice, getProductInfo } from "@/lib/tracker";
import { sendMessage, answerCallbackQuery, pinChatMessage, setMyCommands } from "@/lib/telegram";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

function isValidUrl(s) {
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

const INSTRUCTIONS = `👋 Welcome to Price Tracker Bot!

Use these commands:
/start - show welcome and instructions
/instructions - show and pin instructions again
/help - list commands
/track <url> - start tracking a product
/list - list your tracked products
/remove or /remove <url> - stop tracking a product
/frequency - set how often to check prices

Available frequency options:
• 1 minute
• 10 minutes
• 30 minutes
• 1 hour
• 3 hours
• 6 hours

Tip: At any time, send /frequency to update your preference.`;

async function ensureCommands() {
  try {
    await setMyCommands([
      { command: 'start', description: 'Show welcome and instructions' },
      { command: 'instructions', description: 'Show instructions again' },
      { command: 'help', description: 'List available commands' },
      { command: 'track', description: 'Track a product: /track <url>' },
      { command: 'list', description: 'List your tracked products' },
      { command: 'remove', description: 'Stop tracking: /remove or /remove <url>' },
      { command: 'frequency', description: 'Set how often to check prices' },
    ]);
  } catch {}
}

export async function POST(request) {
  // Validate secret token header from Telegram
  const token = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!WEBHOOK_SECRET || token !== WEBHOOK_SECRET) {
    return new Response('unauthorized', { status: 401 });
  }

  const body = await request.json();

  const uri = process.env.MONGODB_URI;
  await dbConnect(uri);
  await ensureCommands();

  // Handle callback queries first
  if (body.callback_query) {
    const q = body.callback_query;
    const chatId = q.message?.chat?.id;
    const data = q.data || '';
    if (!chatId) return new Response('ok');
    try {
      if (data.startsWith('freq:')) {
        const minutes = parseInt(data.split(':')[1], 10);
        if (Number.isFinite(minutes) && minutes > 0) {
          const existing = await ChatSettings.findOne({ chatId: String(chatId) });
          if (existing) { existing.intervalMinutes = minutes; await existing.save(); }
          else { await ChatSettings.create({ chatId: String(chatId), intervalMinutes: minutes }); }
          await answerCallbackQuery(q.id, { text: `Frequency set to ${minutes} minute(s).` });
          await sendMessage(chatId, `✅ Frequency updated to ${minutes} minute(s). I will check your tracked products accordingly.`);
        } else {
          await answerCallbackQuery(q.id);
        }
      } else if (data.startsWith('removeId:')) {
        const id = data.split(':')[1];
        const doc = await Product.findOne({ _id: id, chatId: String(chatId) });
        if (!doc) { await answerCallbackQuery(q.id, { text: 'Item not found.' }); return new Response('ok'); }
        await Product.deleteOne({ _id: id, chatId: String(chatId) });
        await answerCallbackQuery(q.id, { text: 'Removed.' });
        await sendMessage(chatId, `Stopped tracking: ${doc.title ? doc.title + '\n' : ''}${doc.url}`);
      } else {
        await answerCallbackQuery(q.id);
      }
    } catch (e) {
      try { await answerCallbackQuery(q.id, { text: 'Error, try again.' }); } catch {}
    }
    return new Response('ok');
  }

  const msg = body.message;
  if (!msg) return new Response('ok');
  const chatId = msg.chat?.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return new Response('ok');

  // Commands
  if (/^\/start\b/i.test(text)) {
    const m = await sendMessage(chatId, INSTRUCTIONS);
    try { await pinChatMessage(chatId, m.message_id); } catch {}
    return new Response('ok');
  }
  if (/^\/instructions\b/i.test(text)) {
    const m = await sendMessage(chatId, INSTRUCTIONS);
    try { await pinChatMessage(chatId, m.message_id); } catch {}
    return new Response('ok');
  }
  if (/^\/help\b/i.test(text)) {
    await sendMessage(chatId, `Commands:\n/track <url> - start tracking a product URL\n/list - list products you've added\n/remove or /remove <url> - stop tracking a product\n/frequency - set how often to check prices`);
    return new Response('ok');
  }
  if (/^\/track\s*$/i.test(text)) {
    await sendMessage(chatId, "Please add a URL after /track to track your product.\nExample: /track https://example.com/product");
    return new Response('ok');
  }
  if (/^\/track\s+(.+)/i.test(text)) {
    const url = text.replace(/^\/track\s+/i, '').trim();
    if (!isValidUrl(url)) {
      await sendMessage(chatId, "Please provide a valid URL.\nExample: /track https://example.com/product");
      return new Response('ok');
    }
    await sendMessage(chatId, `🔎 Fetching product info for: ${url}`);
    const info = await getProductInfo(url).catch(() => ({}));
    const price = info?.price ?? await getPrice(url);
    const title = info?.title;
    if (price == null) {
      await sendMessage(chatId, "Couldn't detect a price on that page. Try a different link.");
      return new Response('ok');
    }
    // upsert product for this chat
    const existing = await Product.findOne({ url, chatId: String(chatId) });
    if (existing) {
      existing.lastPrice = price;
      if (title && !existing.title) existing.title = title;
      await existing.save();
    } else {
      await Product.create({ url, chatId: String(chatId), lastPrice: price, title });
    }
    const label = title ? `${title}\n${url}` : url;
    await sendMessage(chatId, `✅ Tracking started for:\n${label}\nInitial price: ${price}`);
    return new Response('ok');
  }
  if (/^\/list\b/i.test(text)) {
    const arr = await Product.find({ chatId: String(chatId) }).lean();
    if (!arr.length) { await sendMessage(chatId, 'You have no tracked products.'); return new Response('ok'); }
    const list = arr.map(p => `${p.title ? p.title + "\n" : ''}${p.url} — ${p.lastPrice ?? 'N/A'}`).join("\n\n");
    await sendMessage(chatId, list);
    return new Response('ok');
  }
  if (/^\/remove\s+(.+)/i.test(text)) {
    const url = text.replace(/^\/remove\s+/i, '').trim();
    const res = await Product.deleteOne({ url, chatId: String(chatId) });
    await sendMessage(chatId, res.deletedCount ? `Stopped tracking: ${url}` : `No tracked product found with that URL.`);
    return new Response('ok');
  }
  if (/^\/remove\b/i.test(text)) {
    const arr = await Product.find({ chatId: String(chatId) }).lean();
    if (!arr.length) { await sendMessage(chatId, 'You have no tracked products.'); return new Response('ok'); }
    const max = 25;
    const buttons = arr.slice(0, max).map((p) => {
      const label = (p.title && p.title.length > 60) ? p.title.slice(0, 57) + '…' : (p.title || p.url);
      return [{ text: label, callback_data: `removeId:${p._id}` }];
    });
    const reply_markup = { inline_keyboard: buttons };
    await sendMessage(chatId, 'Select a product to stop tracking:', { reply_markup });
    return new Response('ok');
  }
  if (/^\/frequency\b/i.test(text)) {
    const existing = await ChatSettings.findOne({ chatId: String(chatId) });
    const current = existing?.intervalMinutes ?? 1;
    const reply_markup = {
      inline_keyboard: [[
        { text: '1 min', callback_data: 'freq:1' },
        { text: '10 min', callback_data: 'freq:10' },
        { text: '30 min', callback_data: 'freq:30' }
      ], [
        { text: '1 hour', callback_data: 'freq:60' },
        { text: '3 hours', callback_data: 'freq:180' },
        { text: '6 hours', callback_data: 'freq:360' }
      ]]
    };
    await sendMessage(chatId, `Choose how often to check prices. Current: ${current} minute(s).`, { reply_markup });
    return new Response('ok');
  }

  return new Response('ok');
}

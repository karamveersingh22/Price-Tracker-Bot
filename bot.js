// bot.js — Telegram price tracker worker

// - Polling-based Telegram bot (node-telegram-bot-api)
// - Connects to MongoDB via lib/dbConnect.js
// - Uses lib/tracker.js -> getPrice(url)
// - Schedules periodic checks (node-cron)

// NOTE: environment variables required:
// TELEGRAM_BOT_TOKEN, MONGODB_URI
// Optional: CHECK_CRON, REQUEST_DELAY_MS, RUN_INITIAL_CHECK

try {
  // Load .env if available
  const dotenv = await import('dotenv');
  dotenv.config();
} catch (e) {
  // dotenv not installed
}

import TelegramBot from "node-telegram-bot-api";
import cron from "node-cron";
import dbConnect from "./lib/dbConnect.js";
import Product from "./models/Product.js";
import ChatSettings from "./models/ChatSettings.js";
import { getPrice } from "./lib/tracker.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const CHECK_CRON = process.env.CHECK_CRON || "* * * * *"; // every 1 min for testing
const REQUEST_DELAY_MS = parseInt(process.env.REQUEST_DELAY_MS || "500", 10);
const RUN_INITIAL_CHECK = (process.env.RUN_INITIAL_CHECK || "true") === "true";

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable. Exiting.");
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error("Missing MONGODB_URI environment variable. Exiting.");
  process.exit(1);
}

let bot;
let cronTask;
const perChatIntervals = new Map();

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function addOrUpdateProduct(url, chatId, initialPrice = null) {
  try {
    const existing = await Product.findOne({ url });
    if (existing) {
      existing.chatId = chatId.toString();
      if (initialPrice !== null) existing.lastPrice = initialPrice;
      await existing.save();
      return existing;
    }

    const p = new Product({
      url,
      chatId: chatId.toString(),
      lastPrice: initialPrice
    });
    await p.save();
    return p;
  } catch (err) {
    console.error("addOrUpdateProduct error:", err.message);
    throw err;
  }
}

async function removeProduct(url, chatId) {
  try {
    const res = await Product.deleteOne({ url, chatId: chatId.toString() });
    return res.deletedCount > 0;
  } catch (err) {
    console.error("removeProduct error:", err.message);
    return false;
  }
}

async function listProductsForChat(chatId) {
  try {
    return await Product.find({ chatId: chatId.toString() }).lean();
  } catch (err) {
    console.error("listProductsForChat error:", err.message);
    return [];
  }
}

async function checkAllPrices(sendNotifications = true) {
  const products = await Product.find({});
  console.log(`Checking ${products.length} products`);

  for (const p of products) {
    try {
      const newPrice = await getPrice(p.url);
      if (newPrice == null) {
        console.log(`Could not detect price for ${p.url}`);
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      if (p.lastPrice == null) {
        p.lastPrice = newPrice;
        p.lastCheckedAt = new Date();
        await p.save();
        console.log(`Initialized price for ${p.url}: ${newPrice}`);
      } else if (newPrice !== p.lastPrice) {
        const increased = newPrice > p.lastPrice;
        const text = increased
          ? `⚠️ Price increased!\n${p.url}\nOld: ₹${p.lastPrice}\nNow: ₹${newPrice}`
          : `✅ Price dropped!\n${p.url}\nOld: ₹${p.lastPrice}\nNow: ₹${newPrice}`;

        if (sendNotifications && p.chatId) {
          try {
            await bot.sendMessage(p.chatId.toString(), text, {
              disable_web_page_preview: true
            });
            console.log(`Notified ${p.chatId} about ${p.url}`);
          } catch (e) {
            console.error(`Failed to send TG message to ${p.chatId}:`, e.message);
          }
        }

        p.lastPrice = newPrice;
        p.lastCheckedAt = new Date();
        await p.save();
      } else {
        // No change: notify for testing purposes
        p.lastCheckedAt = new Date();
        await p.save();
        if (sendNotifications && p.chatId) {
          try {
            await bot.sendMessage(p.chatId.toString(), `ℹ️ No price change for now. Still at ₹${p.lastPrice}.\n${p.url}`, {
              disable_web_page_preview: true
            });
          } catch (e) {
            console.error(`Failed to send TG message to ${p.chatId}:`, e.message);
          }
        }
      }
    } catch (err) {
      console.error(`Error while checking ${p.url}:`, err.message);
    }
    await sleep(REQUEST_DELAY_MS);
  }
}

function isValidUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function startBot() {
  await dbConnect(MONGODB_URI);
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

  // Startup instructions (dev-friendly)
  const instructions = `👋 Welcome to Price Tracker Bot!

Use these commands:
/start - show basic help
/help - list commands
/track <url> - start tracking a product
/list - list your tracked products
/remove <url> - stop tracking a product
/frequency - set how often to check prices

Available frequency options:
• 1 minute
• 10 minutes
• 30 minutes
• 1 hour
• 3 hours
• 6 hours

Tip: At any time, send /frequency to update your preference.`;
  console.log(instructions);

  // Advertise commands in the Telegram UI and pin instructions
  try {
    await bot.setMyCommands([
      { command: 'start', description: 'Show welcome and instructions' },
      { command: 'help', description: 'List available commands' },
      { command: 'track', description: 'Track a product: /track <url>' },
      { command: 'list', description: 'List your tracked products' },
      { command: 'remove', description: 'Stop tracking: /remove or /remove <url>' },
      { command: 'frequency', description: 'Set how often to check prices' },
      { command: 'instructions', description: 'Show instructions again' },
    ]);
  } catch (e) {
    console.error('Failed to set bot commands', e.message);
  }

  bot.onText(/\/start/, async (msg) => {
    try {
      const m = await bot.sendMessage(msg.chat.id, instructions);
      try { await bot.pinChatMessage(msg.chat.id, m.message_id); } catch {}
    } catch (e) {
      console.error('Failed to send instructions', e.message);
    }
  });

  bot.onText(/\/instructions/, async (msg) => {
    try {
      const m = await bot.sendMessage(msg.chat.id, instructions);
      try { await bot.pinChatMessage(msg.chat.id, m.message_id); } catch {}
    } catch (e) {
      console.error('Failed to send instructions', e.message);
    }
  });

  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `Commands:\n/track <url> - start tracking a product URL\n/list - list products you've added\n/remove <url> - stop tracking a product`
    );
  });

  // If user types only /track, prompt for URL
  bot.onText(/^\/track\s*$/i, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "Please add a URL after /track to track your product.\nExample: /track https://example.com/product");
  });

  bot.onText(/\/track (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match && match[1] ? match[1].trim() : null;
    if (!url || !isValidUrl(url)) {
      return bot.sendMessage(chatId, "Please provide a valid URL.\nExample: /track https://example.com/product");
    }

    bot.sendMessage(chatId, `🔎 Fetching price for: ${url}`);
    try {
      const price = await getPrice(url);
      if (price == null)
        return bot.sendMessage(chatId, `Couldn't detect a price on that page. Try a different link.`);
      await addOrUpdateProduct(url, chatId, price);
      bot.sendMessage(chatId, `✅ Tracking started for:\n${url}\nInitial price: ₹${price}`);
    } catch (err) {
      console.error('track handler error', err.message);
      bot.sendMessage(chatId, `Error while starting tracking: ${err.message}`);
    }
  });

  bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const arr = await listProductsForChat(chatId);
    if (!arr.length) return bot.sendMessage(chatId, "You have no tracked products.");
    const text = arr.map(p => `${p.url} — ₹${p.lastPrice ?? 'N/A'}`).join("\n");
    try {
      await bot.sendMessage(chatId, text);
    } catch (e) {
      console.error('list send error', e.message);
      await bot.sendMessage(chatId, 'List too long. Check dashboard for full view.');
    }
  });

  bot.onText(/\/remove (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const url = match && match[1] ? match[1].trim() : null;
    if (!url) return bot.sendMessage(chatId, 'Please provide a URL to remove or type /remove to pick from your list.');
    const ok = await removeProduct(url, chatId);
    bot.sendMessage(chatId, ok ? `Stopped tracking: ${url}` : `No tracked product found with that URL.`);
  });

  // If user types only /remove, show inline list to choose
  bot.onText(/^\/remove$/i, async (msg) => {
    const chatId = msg.chat.id;
    const arr = await listProductsForChat(chatId);
    if (!arr.length) return bot.sendMessage(chatId, 'You have no tracked products.');
    const max = 25;
    const buttons = arr.slice(0, max).map((p) => {
      const label = (p.title && p.title.length > 60) ? p.title.slice(0, 57) + '…' : (p.title || p.url);
      return [{ text: label, callback_data: `removeId:${p._id}` }];
    });
    if (arr.length > max) buttons.push([{ text: `+ ${arr.length - max} more not shown`, callback_data: 'noop' }]);
    await bot.sendMessage(chatId, 'Select a product to stop tracking:', {
      reply_markup: { inline_keyboard: buttons }
    });
  });

  bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;
  });

  // Frequency selection
  const freqKeyboard = {
    reply_markup: {
      inline_keyboard: [[
        { text: '1 min', callback_data: 'freq:1' },
        { text: '10 min', callback_data: 'freq:10' },
        { text: '30 min', callback_data: 'freq:30' }
      ], [
        { text: '1 hour', callback_data: 'freq:60' },
        { text: '3 hours', callback_data: 'freq:180' },
        { text: '6 hours', callback_data: 'freq:360' }
      ]]
    }
  };

  bot.onText(/\/frequency/, async (msg) => {
    const chatId = msg.chat.id;
    const existing = await ChatSettings.findOne({ chatId: chatId.toString() });
    const current = existing?.intervalMinutes ?? 1;
    bot.sendMessage(chatId, `Choose how often to check prices. Current: ${current} minute(s).`, freqKeyboard);
  });

  bot.on('callback_query', async (query) => {
    try {
      const chatId = query.message.chat.id;
      const data = query.data || '';
      if (data.startsWith('freq:')) {
        const minutes = parseInt(data.split(':')[1], 10);
        if (!Number.isFinite(minutes) || minutes <= 0) {
          return bot.answerCallbackQuery(query.id);
        }
        const existing = await ChatSettings.findOne({ chatId: chatId.toString() });
        if (existing) {
          existing.intervalMinutes = minutes;
          await existing.save();
        } else {
          await ChatSettings.create({ chatId: chatId.toString(), intervalMinutes: minutes });
        }
        await bot.answerCallbackQuery(query.id, { text: `Frequency set to ${minutes} minute(s).` });
        await bot.sendMessage(chatId, `✅ Frequency updated to ${minutes} minute(s). I will check your tracked products accordingly.`);
        setupPerChatInterval(chatId, minutes);
      } else if (data.startsWith('removeId:')) {
        const id = data.split(':')[1];
        const doc = await Product.findOne({ _id: id, chatId: chatId.toString() });
        if (!doc) {
          return bot.answerCallbackQuery(query.id, { text: 'Item not found.' });
        }
        await Product.deleteOne({ _id: id, chatId: chatId.toString() });
        await bot.answerCallbackQuery(query.id, { text: 'Removed.' });
        await bot.sendMessage(chatId, `Stopped tracking: ${doc.title ? doc.title + '\n' : ''}${doc.url}`);
      } else {
        await bot.answerCallbackQuery(query.id);
      }
    } catch (e) {
      console.error('callback_query error', e.message);
      try { await bot.answerCallbackQuery(query.id, { text: 'Error, try again.' }); } catch {}
    }
  });

  cronTask = cron.schedule(CHECK_CRON, async () => {
    console.log(new Date().toISOString(), "- scheduled price check starting");
    try {
      await checkAllPrices(true);
    } catch (e) {
      console.error('Scheduled check failed:', e.message);
    }
  });

  if (RUN_INITIAL_CHECK) {
    console.log('Running initial price check...');
    try { await checkAllPrices(false); } catch (e) { console.error('Initial check failed:', e.message); }
  }

  // Initialize per-chat timers from DB
  try {
    const settings = await ChatSettings.find({}).lean();
    for (const s of settings) {
      setupPerChatInterval(s.chatId, s.intervalMinutes || 1);
    }
  } catch (e) {
    console.error('Failed to init per-chat timers', e.message);
  }

  console.log('Telegram bot started and polling.');
}

async function shutdown(signal) {
  console.log(`Received ${signal} - shutting down...`);
  try { if (cronTask) cronTask.stop(); } catch {}
  try {
    // Clear per-chat intervals
    for (const id of perChatIntervals.values()) clearInterval(id);
    perChatIntervals.clear();
  } catch {}
  try { if (bot && bot.stopPolling) await bot.stopPolling(); } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startBot().catch((err) => {
  console.error('Fatal error starting bot:', err.message);
  process.exit(1);
});

function setupPerChatInterval(chatId, minutes) {
  try {
    const key = chatId.toString();
    if (perChatIntervals.has(key)) {
      clearInterval(perChatIntervals.get(key));
      perChatIntervals.delete(key);
    }
    const ms = minutes * 60 * 1000;
    const id = setInterval(async () => {
      try {
        // Only check products belonging to this chat
        const products = await Product.find({ chatId: key });
        for (const p of products) {
          try {
            const newPrice = await getPrice(p.url);
            if (newPrice == null) continue;
            if (p.lastPrice == null) {
              p.lastPrice = newPrice;
              p.lastCheckedAt = new Date();
              await p.save();
              await bot.sendMessage(key, `Initialized price: ₹${newPrice}\n${p.url}`, { disable_web_page_preview: true });
            } else if (newPrice !== p.lastPrice) {
              const increased = newPrice > p.lastPrice;
              const text = increased
                ? `⚠️ Price increased!\n${p.url}\nOld: ₹${p.lastPrice}\nNow: ₹${newPrice}`
                : `✅ Price dropped!\n${p.url}\nOld: ₹${p.lastPrice}\nNow: ₹${newPrice}`;
              await bot.sendMessage(key, text, { disable_web_page_preview: true });
              p.lastPrice = newPrice;
              p.lastCheckedAt = new Date();
              await p.save();
            } else {
              p.lastCheckedAt = new Date();
              await p.save();
              await bot.sendMessage(key, `ℹ️ No price change for now. Still at ₹${p.lastPrice}.\n${p.url}`, { disable_web_page_preview: true });
            }
          } catch {}
          await sleep(REQUEST_DELAY_MS);
        }
      } catch (e) {
        console.error('per-chat interval error', e.message);
      }
    }, ms);
    perChatIntervals.set(key, id);
  } catch (e) {
    console.error('setupPerChatInterval error', e.message);
  }
}

export async function tgApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(json.description || 'Telegram API error');
  }
  return json.result;
}

export function sendMessage(chat_id, text, options = {}) {
  return tgApi('sendMessage', { chat_id, text, ...options });
}

export function answerCallbackQuery(callback_query_id, options = {}) {
  return tgApi('answerCallbackQuery', { callback_query_id, ...options });
}

export function pinChatMessage(chat_id, message_id) {
  return tgApi('pinChatMessage', { chat_id, message_id });
}

export function setMyCommands(commands) {
  return tgApi('setMyCommands', { commands });
}

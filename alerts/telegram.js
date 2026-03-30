import axios from "axios";

export async function sendTelegram(msg) {
  const token = process.env.TG_TOKEN;
  const chatId = process.env.TG_CHAT;
  if (!token || !chatId) return;

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: msg },
    { timeout: 5000 }
  );
}

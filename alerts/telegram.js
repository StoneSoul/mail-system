import axios from "axios";

export async function sendTelegram(msg) {
  if (!process.env.TG_TOKEN) return;

  await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
    chat_id: process.env.TG_CHAT,
    text: msg
  });
}
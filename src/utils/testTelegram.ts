import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;
const LOG_CHAT_ID = process.env.TELEGRAM_LOG_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID;

async function sendTestMessage() {
  if (!BOT_TOKEN || !ALERT_CHAT_ID || !LOG_CHAT_ID) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN, TELEGRAM_ALERT_CHAT_ID, or TELEGRAM_LOG_CHAT_ID in .env");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    await axios.post(url, {
      chat_id: ALERT_CHAT_ID,
      text: "CT Trend Hunter alert-channel test message"
    });

    await axios.post(url, {
      chat_id: LOG_CHAT_ID,
      text: "CT Trend Hunter log-chat test message"
    });

    console.log("✅ Message sent successfully");
  } catch (err: any) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
}

sendTestMessage();

import axios, { AxiosInstance } from "axios";
import { env, requireTelegramConfig } from "../../config/env";
import { AlertPayload, PollReportPayload } from "../../types/trends";
import { escapeTelegramMarkdown, getZonedParts } from "../../utils/time";
import { logger } from "../../utils/logger";
import { withRetry } from "../../utils/retry";

const renderTrackedQuotes = (payload: AlertPayload): string => {
  if (payload.trackedQuotes.length === 0) {
    return "None yet";
  }

  return payload.trackedQuotes
    .map((quote, index) => `${index + 1}. @${quote.trackedAccountUsername} - ${quote.quoteTweetUrl}`)
    .join("\n");
};

const renderMessage = (payload: AlertPayload): string => {
  return [
    "Trend detected",
    "",
    "Original tweet:",
    `@${payload.originalAuthorUsername}`,
    payload.originalText,
    "",
    typeof payload.originalAuthorFollowersCount === "number"
      ? `Author followers: ${payload.originalAuthorFollowersCount}`
      : null,
    typeof payload.originalAuthorFollowersCount === "number" ? "" : null,
    "Original link:",
    payload.originalUrl,
    "",
    "Metrics:",
    `Quotes: ${payload.metrics.quoteCount}`,
    `Likes: ${payload.metrics.likeCount}`,
    `Replies: ${payload.metrics.replyCount}`,
    `Views: ${payload.metrics.viewCount}`,
    "",
    "Tracked accounts already on this trend:",
    renderTrackedQuotes(payload)
  ].filter((line): line is string => line !== null).join("\n");
};

const formatLocalTime = (isoDate: string): string => {
  const parts = getZonedParts(new Date(isoDate), env.timezone);
  return `${parts.hour}:${String(parts.minute).padStart(2, "0")}`;
};

const formatPollWindow = (payload: PollReportPayload): string => {
  return `${formatLocalTime(payload.since)} - ${formatLocalTime(payload.until)}`;
};

const renderPollReportParts = (payload: PollReportPayload): string[] => {
  const headerLines = [
    "CT Trend Hunter: check completed",
    "",
    `Window: ${formatPollWindow(payload)}`,
    `Bootstrap skip alerts: ${payload.skipAlertsThisCycle ? "yes" : "no"}`,
    `Trend alerts found: ${payload.trendAlertsCount}`,
    ""
  ];

  const visibleAccounts = payload.accounts.filter((account) => account.foundTweets > 0);
  const accountLines = visibleAccounts.map((account) => {
    const status = account.errors > 0 ? "error" : "ok";
    const mode = account.mode === "trend-maker" ? "maker" : "catcher";
    return [
      `@${account.username} (${mode}): ${account.foundTweets} tweets`,
      `new quotes: ${account.newQuoteTweets}`,
      `known quotes: ${account.knownQuoteTweets}`,
      `own tweets checked: ${account.ownTweetsChecked}`,
      `alert candidates: ${account.candidateQuoteTweets}`,
      `old originals ignored: ${account.staleQuoteTweets}`,
      `giveaways ignored: ${account.giveawayIgnoredTweets}`,
      `projects ignored: ${account.projectIgnoredTweets}`,
      `status: ${status}`
    ].join(" | ");
  });

  const maxMessageLength = 3500;
  const parts: string[] = [];
  let currentLines = [...headerLines, "Accounts:"];

  if (accountLines.length === 0) {
    return [[...currentLines, "No accounts with tweets in this window."].join("\n")];
  }

  for (const line of accountLines) {
    const nextMessage = [...currentLines, line].join("\n");
    if (nextMessage.length > maxMessageLength && currentLines.length > headerLines.length + 1) {
      parts.push(currentLines.join("\n"));
      currentLines = ["CT Trend Hunter: check completed (continued)", "", "Accounts:", line];
      continue;
    }

    currentLines.push(line);
  }

  parts.push(currentLines.join("\n"));
  return parts;
};

export class TelegramService {
  private readonly http: AxiosInstance;

  constructor() {
    const botToken = env.dryRun ? "dry-run" : requireTelegramConfig().telegramBotToken;

    this.http = axios.create({
      baseURL: `https://api.telegram.org/bot${botToken}`,
      timeout: env.httpTimeoutMs
    });
  }

  async sendAlert(payload: AlertPayload): Promise<void> {
    const message = renderMessage(payload);

    if (env.dryRun) {
      logger.info("Dry-run alert", { message });
      return;
    }

    const { telegramAlertChatId } = requireTelegramConfig();
    const photoUrl = payload.mediaUrls?.[0];

    if (photoUrl) {
      try {
        await this.sendPhotoToChat(telegramAlertChatId, photoUrl, message);
        return;
      } catch (error) {
        logger.warn("Failed to send alert photo, falling back to text alert", {
          photoUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    await this.sendToChat(telegramAlertChatId, message, {
      disableWebPagePreview: false
    });
  }

  async sendText(message: string): Promise<void> {
    if (env.dryRun) {
      logger.info("Dry-run Telegram message", { message });
      return;
    }

    const { telegramLogChatId } = requireTelegramConfig();
    await this.sendToChat(telegramLogChatId, message, {
      disableWebPagePreview: true
    });
  }

  private async sendToChat(
    chatId: string,
    message: string,
    options?: { parseMode?: string; disableWebPagePreview?: boolean }
  ): Promise<void> {
    await withRetry("telegram sendMessage", env.httpRetryAttempts, async () => {
      await this.http.post("/sendMessage", {
        chat_id: chatId,
        text: message,
        parse_mode: options?.parseMode,
        disable_web_page_preview: options?.disableWebPagePreview ?? true
      });
    });
  }

  private async sendPhotoToChat(chatId: string, photoUrl: string, caption: string): Promise<void> {
    await withRetry("telegram sendPhoto", env.httpRetryAttempts, async () => {
      await this.http.post("/sendPhoto", {
        chat_id: chatId,
        photo: photoUrl,
        caption: caption.slice(0, 1024)
      });
    });

    if (caption.length > 1024) {
      await this.sendToChat(chatId, caption, {
        disableWebPagePreview: true
      });
    }
  }

  async sendPollReport(payload: PollReportPayload): Promise<void> {
    for (const message of renderPollReportParts(payload)) {
      await this.sendText(message);
    }
  }
}

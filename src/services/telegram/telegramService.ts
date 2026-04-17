import axios, { AxiosInstance } from "axios";
import { env, requireTelegramConfig } from "../../config/env";
import { AlertPayload, PollReportPayload } from "../../types/trends";
import { escapeTelegramMarkdown, getZonedParts } from "../../utils/time";
import { logger } from "../../utils/logger";
import { withRetry } from "../../utils/retry";

interface TelegramMediaPhoto {
  type: "photo";
  media: string;
  caption?: string;
}

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
    const roles = account.roles
      .map((role) => (role === "trend-maker" ? "maker" : "catcher"))
      .sort((a, b) => a.localeCompare(b));
    const roleLabel = roles.length === 2 ? "maker+catcher" : roles[0] ?? "unknown";
    const ignoredReasons = [
      account.staleQuoteTweets > 0 ? "old post" : null,
      account.giveawayIgnoredTweets > 0 ? "giveaway" : null,
      account.projectIgnoredTweets > 0 ? "project" : null,
      account.alreadyAlertedTweets > 0 ? "already sent" : null
    ].filter((reason): reason is string => reason !== null);
    const ignored = ignoredReasons.length > 0 ? `yes | reason: ${ignoredReasons.join(", ")}` : "no";
    return [
      `@${account.username} (${roleLabel}): ${account.foundTweets} tweets`,
      `new quotes: ${account.newQuoteTweets}`,
      `alert candidates: ${account.candidateQuoteTweets}`,
      `ignored: ${ignored}`,
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
      logger.info("Dry-run alert", { message, mediaUrls: payload.mediaUrls ?? [] });
      return;
    }

    const { telegramAlertChatId, telegramLogChatId } = requireTelegramConfig();
    const targetChatIds = [...new Set([telegramAlertChatId, telegramLogChatId])];

    for (const chatId of targetChatIds) {
      await this.sendAlertToChat(chatId, payload.mediaUrls ?? [], message);
    }
  }

  async sendText(message: string): Promise<void> {
    if (env.dryRun) {
      logger.info("Dry-run Telegram message", { message });
      return;
    }

    const { telegramLogChatId, telegramAlertChatId } = requireTelegramConfig();
    const targetChatIds = [...new Set([telegramLogChatId, telegramAlertChatId])];

    for (const chatId of targetChatIds) {
      await this.sendToChat(chatId, message, {
        disableWebPagePreview: true
      });
    }
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

  private async sendMediaGroupToChat(chatId: string, mediaUrls: string[], caption?: string): Promise<void> {
    const batches: string[][] = [];
    for (let index = 0; index < mediaUrls.length; index += 10) {
      batches.push(mediaUrls.slice(index, index + 10));
    }

    for (const [batchIndex, batch] of batches.entries()) {
      const media: TelegramMediaPhoto[] = batch.map((url, index) => ({
        type: "photo",
        media: url,
        caption: batchIndex === 0 && index === 0 ? caption?.slice(0, 1024) : undefined
      }));

      await withRetry("telegram sendMediaGroup", env.httpRetryAttempts, async () => {
        await this.http.post("/sendMediaGroup", {
          chat_id: chatId,
          media
        });
      });
    }
  }

  private async sendAlertToChat(chatId: string, mediaUrls: string[], message: string): Promise<void> {
    if (mediaUrls.length === 0) {
      await this.sendToChat(chatId, message, {
        disableWebPagePreview: false
      });
      return;
    }

    if (mediaUrls.length === 1) {
      try {
        await this.sendPhotoToChat(chatId, mediaUrls[0]!, message);
        return;
      } catch (error) {
        logger.warn("Failed to send alert photo, falling back to text alert", {
          photoUrl: mediaUrls[0]!,
          error: error instanceof Error ? error.message : String(error)
        });
        await this.sendToChat(chatId, message, {
          disableWebPagePreview: false
        });
        return;
      }
    }

    try {
      await this.sendMediaGroupToChat(chatId, mediaUrls, message);
      if (message.length > 1024) {
        await this.sendToChat(chatId, message, {
          disableWebPagePreview: true
        });
      }
      return;
    } catch (error) {
      logger.warn("Failed to send alert media group, falling back to text alert", {
        mediaCount: mediaUrls.length,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.sendToChat(chatId, message, {
        disableWebPagePreview: false
      });
    }
  }

  async sendPollReport(payload: PollReportPayload): Promise<void> {
    const messages = renderPollReportParts(payload);
    if (env.dryRun) {
      for (const message of messages) {
        logger.info("Dry-run Telegram poll report", { message });
      }
      return;
    }

    const { telegramLogChatId, telegramAlertChatId } = requireTelegramConfig();
    const targetChatIds = [...new Set([telegramLogChatId, telegramAlertChatId])];

    for (const chatId of targetChatIds) {
      for (const message of messages) {
        await this.sendToChat(chatId, message, {
          disableWebPagePreview: true
        });
      }
    }
  }
}

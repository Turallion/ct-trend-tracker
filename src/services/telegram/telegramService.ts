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

const describeTelegramError = (error: unknown): string => {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data;
    if (typeof data === "string") {
      return data;
    }

    if (data && typeof data === "object") {
      return JSON.stringify(data);
    }
  }

  return error instanceof Error ? error.message : String(error);
};

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

const formatIgnoredReason = (reason: string | null): string => (reason ? "yes" : "no");

const chunkReportMessages = (
  initialLines: string[],
  blocks: string[][],
  continuedTitle: string,
  maxMessageLength = 3500
): string[] => {
  if (blocks.length === 0) {
    return [initialLines.join("\n")];
  }

  const parts: string[] = [];
  let currentLines = [...initialLines];

  for (const block of blocks) {
    const nextMessage = [...currentLines, ...block, ""].join("\n");
    if (nextMessage.length > maxMessageLength) {
      if (currentLines[currentLines.length - 1] === "") {
        currentLines.pop();
      }
      parts.push(currentLines.join("\n"));
      currentLines = [continuedTitle, ...initialLines.slice(1), ...block];
      continue;
    }

    currentLines.push(...block, "");
  }

  if (currentLines[currentLines.length - 1] === "") {
    currentLines.pop();
  }

  parts.push(currentLines.join("\n"));
  return parts;
};

const renderAccountRoleLabel = (roles: Array<"trend-catcher" | "trend-maker">): string => {
  const hasCatcher = roles.includes("trend-catcher");
  const hasMaker = roles.includes("trend-maker");

  if (hasCatcher && hasMaker) {
    return "maker+catcher";
  }

  if (hasMaker) {
    return "maker";
  }

  return "catcher";
};

const renderDetailedActivityBlocks = (payload: PollReportPayload): string[][] => {
  const blocks: string[][] = [];
  const visibleAccounts = payload.accounts.filter(
    (account) => account.catcherQuoteReports.length > 0 || account.makerDetailedReports.length > 0
  );

  for (const account of visibleAccounts) {
    for (const report of account.catcherQuoteReports) {
      const lines = [
        `@${account.username} (catcher): new tweets: ${account.foundTweets} | new quotes: ${account.newQuoteTweets} | ignored: ${formatIgnoredReason(report.ignoredReason)}`
      ];
      if (report.ignoredReason) {
        lines.push(`reason: ${report.ignoredReason}`);
      }
      lines.push(`link: ${report.quoteTweetUrl}`);
      blocks.push(lines);
    }

    if (account.roles.includes("trend-maker") && account.makerDetailedReports.length > 0) {
      const totalMakerTweets = account.makerDetailedReports.length;
      for (const [index, report] of account.makerDetailedReports.entries()) {
        const lines = [
          `${index + 1}/${totalMakerTweets} @${account.username} (maker): ${report.isNewPost ? "new post" : "old post"}: ${index + 1} | quotes: ${report.quoteCount} | ignored: ${formatIgnoredReason(report.ignoredReason)}`
        ];
        if (report.ignoredReason) {
          lines.push(`reason: ${report.ignoredReason}`);
        }
        lines.push(`link: ${report.tweetUrl}`);
        blocks.push(lines);
      }
    }
  }

  return blocks;
};

const renderDetailedReportParts = (payload: PollReportPayload): string[] => {
  const headerLines = [
    "CT Trend Hunter: detailed report",
    "",
    `Window: ${formatPollWindow(payload)}`,
    `Bootstrap skip alerts: ${payload.skipAlertsThisCycle ? "yes" : "no"}`,
    `Trend alerts found: ${payload.trendAlertsCount}`,
    ""
  ];

  const activityBlocks = renderDetailedActivityBlocks(payload);
  if (activityBlocks.length === 0) {
    return [headerLines.join("\n")];
  }

  return chunkReportMessages([...headerLines, "Detailed activity:"], activityBlocks, "CT Trend Hunter: detailed report (continued)");
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

    const { telegramAlertChatId } = requireTelegramConfig();
    await this.sendAlertToChat(telegramAlertChatId, payload.mediaUrls ?? [], message);
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

  async sendDetailedReport(payload: PollReportPayload): Promise<void> {
    const messages = renderDetailedReportParts(payload);

    if (env.dryRun) {
      for (const message of messages) {
        logger.info("Dry-run Telegram detailed report", { message });
      }
      return;
    }

    if (!env.telegramChatId) {
      logger.warn("Skipping detailed report because TELEGRAM_CHAT_ID is missing");
      return;
    }

    for (const message of messages) {
      try {
        await this.sendToChat(env.telegramChatId, message, {
          disableWebPagePreview: true
        });
      } catch (error) {
        logger.error("Failed to send detailed report message", {
          chatId: env.telegramChatId,
          error: describeTelegramError(error),
          messagePreview: message.slice(0, 200)
        });
        throw error;
      }
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
    const messages = renderDetailedReportParts(payload);
    if (env.dryRun) {
      for (const message of messages) {
        logger.info("Dry-run Telegram poll report", { message });
      }
      return;
    }

    const { telegramLogChatId } = requireTelegramConfig();

    for (const message of messages) {
      await this.sendToChat(telegramLogChatId, message, {
        disableWebPagePreview: true
      });
    }
  }
}

import { originalTweetRepository } from "../../db/repositories";
import { DailySummaryPayload } from "../../types/trends";
import { zonedDateTimeToUtc } from "../../utils/time";
import { logger } from "../../utils/logger";
import { TelegramService } from "../telegram/telegramService";
import { AdvancedSearchService } from "../twitter/advancedSearchService";

export class DailySummaryService {
  constructor(
    private readonly searchService: AdvancedSearchService,
    private readonly telegramService: TelegramService
  ) {}

  async sendDailySummary(input: {
    dateKey: string;
    timezone: string;
    workStartHour: number;
    workEndHour: number;
  }): Promise<void> {
    const [year, month, day] = input.dateKey.split("-").map(Number);
    if (!year || !month || !day) {
      throw new Error(`Invalid date key for daily summary: ${input.dateKey}`);
    }

    const since = zonedDateTimeToUtc(input.timezone, {
      year,
      month,
      day,
      hour: input.workStartHour,
      minute: 0,
      second: 0
    }).toISOString();
    const until = zonedDateTimeToUtc(input.timezone, {
      year,
      month,
      day,
      hour: 23,
      minute: 59,
      second: 0
    }).toISOString();

    const alertedTweets = originalTweetRepository.listAlertedBetween(since, until);

    for (const tweet of alertedTweets) {
      try {
        const latest = await this.searchService.getTweetById(tweet.originalTweetId, tweet.originalAuthorUsername);
        if (latest) {
          originalTweetRepository.updateCurrentMetrics(tweet.originalTweetId, latest.metrics);
          tweet.currentQuoteCount = latest.metrics.quoteCount;
        }
      } catch (error) {
        logger.warn("Failed to refresh daily summary tweet metrics", {
          originalTweetId: tweet.originalTweetId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    alertedTweets.sort((a, b) => b.currentQuoteCount - a.currentQuoteCount || a.alertSentAt.localeCompare(b.alertSentAt));

    const payload: DailySummaryPayload = {
      dateLabel: input.dateKey,
      trendAlertsSent: alertedTweets.length,
      trends: alertedTweets
    };

    await this.telegramService.sendDailySummary(payload);
  }
}

import { trackedAccountRepository, quoteRepository, originalTweetRepository } from "../../db/repositories";
import { env } from "../../config/env";
import { AdvancedSearchService } from "../twitter/advancedSearchService";
import { detectQuoteTweet } from "../twitter/quoteTweetDetector";
import { isOriginalTweetTooOld } from "./helpers";
import { TrendRepositoryService } from "./trendRepositoryService";
import { TrendScoringService } from "./trendScoringService";
import { TelegramService } from "../telegram/telegramService";
import { logger } from "../../utils/logger";
import { AccountPollStats, AlertPayload, TrendSignal } from "../../types/trends";
import { NormalizedTweet } from "../../types/twitter";
import { listTrendMakers, TrendMakerConfigRecord } from "./trendMakerConfig";
import { QualityFilterService, QualityIgnoreReason } from "./qualityFilterService";

interface PendingTrendAlert {
  originalTweetId: string;
  signals: TrendSignal[];
  payload: AlertPayload;
}

type PendingTrendAlerts = Map<string, PendingTrendAlert>;

export class TrendMonitorService {
  private completedPollCycles = 0;

  constructor(
    private readonly searchService: AdvancedSearchService,
    private readonly trendRepositoryService: TrendRepositoryService,
    private readonly trendScoringService: TrendScoringService,
    private readonly telegramService: TelegramService,
    private readonly qualityFilterService = new QualityFilterService()
  ) {}

  async pollWindow(
    since: string,
    until: string,
    options?: {
      accountUsernames?: string[];
      maxSearchPages?: number;
      skipRefresh?: boolean;
      useServerTimeWindow?: boolean;
    }
  ): Promise<void> {
    const skipAlertsThisCycle = env.skipAlertsOnFirstRun && this.completedPollCycles === 0;
    const trackedAccounts = trackedAccountRepository
      .listActive()
      .filter((account) => !options?.accountUsernames || options.accountUsernames.includes(account.username));
    logger.info("Polling tracked accounts", {
      trackedAccounts: trackedAccounts.length,
      since,
      until,
      skipAlertsThisCycle,
      maxSearchPages: options?.maxSearchPages ?? env.advancedSearchMaxPages,
      skipRefresh: Boolean(options?.skipRefresh),
      useServerTimeWindow: Boolean(options?.useServerTimeWindow)
    });

    const accountStats: AccountPollStats[] = [];
    const pendingAlerts: PendingTrendAlerts = new Map();
    const queue = [...trackedAccounts];
    const concurrency = Math.min(env.pollConcurrency, trackedAccounts.length || 1);
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const account = queue.shift();
        if (!account) {
          return;
        }
        const stats = await this.processTrackedAccount(
          account.username,
          since,
          until,
          skipAlertsThisCycle,
          pendingAlerts,
          options?.maxSearchPages,
          options?.useServerTimeWindow
        );
        accountStats.push(stats);
      }
    });

    await Promise.all(workers);

    await this.processTrendMakers(until, skipAlertsThisCycle, pendingAlerts, accountStats, options);

    if (env.enableSignalA && !options?.skipRefresh) {
      await this.refreshRecentOriginalTweets(skipAlertsThisCycle, pendingAlerts);
    }

    if (env.sendPollReports) {
      await this.telegramService.sendPollReport({
        since,
        until,
        accounts: accountStats.sort((a, b) => a.username.localeCompare(b.username)),
        trendAlertsCount: pendingAlerts.size,
        skipAlertsThisCycle
      });

      if (pendingAlerts.size === 0) {
        await this.telegramService.sendText("No trend detected");
      }
    }

    for (const alert of pendingAlerts.values()) {
      await this.telegramService.sendAlert(alert.payload);
      this.trendRepositoryService.markSignalsTriggered(alert.originalTweetId, alert.signals);
      logger.info("Alert sent for original tweet", {
        originalTweetId: alert.originalTweetId,
        signals: alert.signals
      });
    }

    this.completedPollCycles += 1;
  }

  private async processTrackedAccount(
    username: string,
    since: string,
    until: string,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    maxSearchPages?: number,
    useServerTimeWindow?: boolean
  ): Promise<AccountPollStats> {
    const stats: AccountPollStats = {
      username,
      mode: "trend-catcher",
      foundTweets: 0,
      newQuoteTweets: 0,
      knownQuoteTweets: 0,
      ownTweetsChecked: 0,
      staleQuoteTweets: 0,
      giveawayIgnoredTweets: 0,
      projectIgnoredTweets: 0,
      baselineQuoteTweets: 0,
      candidateQuoteTweets: 0,
      errors: 0
    };

    try {
      const tweets = await this.searchService.searchAccountWindow(username, since, until, {
        maxPages: maxSearchPages,
        useServerTimeWindow
      });
      stats.foundTweets = tweets.length;
      logger.info("Fetched tweets for tracked account", { username, count: tweets.length });

      for (const tweet of tweets) {
        if (quoteRepository.isQuoteTweetKnown(tweet.id)) {
          stats.knownQuoteTweets += 1;
          continue;
        }

        const detection = detectQuoteTweet(tweet);
        if (!detection) {
          continue;
        }
        stats.newQuoteTweets += 1;

        const detectedAt = new Date().toISOString();
        const tooOld = isOriginalTweetTooOld(
          detection.originalTweet.createdAt,
          new Date(detectedAt),
          env.originalTweetMaxAgeHours
        );

        const storedOriginal = this.trendRepositoryService.saveDetectedQuote({
          trackedAccountUsername: username,
          detectedAt,
          quoteTweet: detection.quoteTweet,
          originalTweet: detection.originalTweet
        });

        if (tooOld) {
          this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
            originalTweetId: storedOriginal.originalTweetId,
            originalAuthorUsername: detection.originalTweet.author.username,
            originalText: detection.originalTweet.text,
            originalUrl: detection.originalTweet.url,
            originalCreatedAt: detection.originalTweet.createdAt,
            firstSeenAt: detectedAt,
            checkedAt: detectedAt,
            isTooOld: true,
            metrics: detection.originalTweet.metrics,
            ignoredReason: "too_old"
          });
          logger.info("Ignoring stale original tweet", {
            originalTweetId: storedOriginal.originalTweetId,
            originalCreatedAt: detection.originalTweet.createdAt
          });
          stats.staleQuoteTweets += 1;
          continue;
        }

        const trackedQuotes = this.trendRepositoryService.getTrackedQuotes(storedOriginal.originalTweetId);
        const baselineCheckedAt = detectedAt;
        this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
          originalTweetId: storedOriginal.originalTweetId,
          originalAuthorUsername: detection.originalTweet.author.username,
          originalText: detection.originalTweet.text,
          originalUrl: detection.originalTweet.url,
          originalCreatedAt: detection.originalTweet.createdAt,
          firstSeenAt: baselineCheckedAt,
          checkedAt: baselineCheckedAt,
          isTooOld: false,
          metrics: detection.originalTweet.metrics
        });

        const qualityFilter = this.qualityFilterService.evaluate(detection.originalTweet);
        if (qualityFilter) {
          this.trendRepositoryService.markOriginalTweetIgnored(storedOriginal.originalTweetId, qualityFilter.reason);
          this.incrementQualityFilterStats(stats, qualityFilter.reason);
          logger.info("Ignoring original tweet by quality filter", {
            originalTweetId: storedOriginal.originalTweetId,
            reason: qualityFilter.reason,
            matched: qualityFilter.matched
          });
          continue;
        }

        if (skipAlertsThisCycle) {
          logger.info("Skipping alerts on bootstrap cycle", {
            originalTweetId: storedOriginal.originalTweetId
          });
          stats.baselineQuoteTweets += 1;
          continue;
        }
        stats.candidateQuoteTweets += 1;
        if (this.trendRepositoryService.hasAlreadyBeenAlerted(storedOriginal.originalTweetId)) {
          logger.info("Skipping already alerted original tweet", {
            originalTweetId: storedOriginal.originalTweetId
          });
          continue;
        }

        const triggeredSignals = this.trendRepositoryService.getTriggeredSignals(storedOriginal.originalTweetId);

        const oldestSnapshot = originalTweetRepository.getOldestSnapshotWithinWindow(storedOriginal.originalTweetId, 4);
        const result = this.trendScoringService.evaluateSignals({
          originalTweetId: storedOriginal.originalTweetId,
          currentMetrics: detection.originalTweet.metrics,
          baselineQuoteCount: oldestSnapshot?.quoteCount ?? detection.originalTweet.metrics.quoteCount,
          trackedQuoteCount: new Set(trackedQuotes.map((quote) => quote.trackedAccountUsername)).size,
          alreadyTriggered: {
            a: triggeredSignals.includes("A"),
            b: triggeredSignals.includes("B"),
            c: triggeredSignals.includes("C")
          },
          originalAuthorUsername: detection.originalTweet.author.username,
          originalText: detection.originalTweet.text,
          originalUrl: detection.originalTweet.url,
          originalAuthorFollowersCount: detection.originalTweet.author.followersCount ?? storedOriginal.originalAuthorFollowersCount,
          mediaUrls: detection.originalTweet.mediaUrls,
          trackedQuotes
        });

        if (result.payload && result.signals.length > 0) {
          this.addPendingAlert(pendingAlerts, {
            originalTweetId: storedOriginal.originalTweetId,
            signals: result.signals,
            payload: result.payload
          });
        }
      }
    } catch (error) {
      stats.errors += 1;
      logger.error("Failed to process tracked account", {
        username,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return stats;
  }

  private async processTrendMakers(
    until: string,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    accountStats: AccountPollStats[],
    options?: {
      maxSearchPages?: number;
      skipRefresh?: boolean;
      useServerTimeWindow?: boolean;
    }
  ): Promise<void> {
    const trendMakers = listTrendMakers();
    if (trendMakers.length === 0) {
      return;
    }

    const queue = [...trendMakers];
    const concurrency = Math.min(env.pollConcurrency, trendMakers.length);
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const maker = queue.shift();
        if (!maker) {
          return;
        }

        const stats = await this.processTrendMaker(
          maker,
          until,
          skipAlertsThisCycle,
          pendingAlerts,
          options?.maxSearchPages,
          options?.useServerTimeWindow
        );
        accountStats.push(stats);
      }
    });

    await Promise.all(workers);
  }

  private async processTrendMaker(
    maker: TrendMakerConfigRecord,
    until: string,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    maxSearchPages?: number,
    useServerTimeWindow?: boolean
  ): Promise<AccountPollStats> {
    const since = new Date(new Date(until).getTime() - maker.lookbackHours * 60 * 60 * 1000).toISOString();
    const stats: AccountPollStats = {
      username: maker.username,
      mode: "trend-maker",
      foundTweets: 0,
      newQuoteTweets: 0,
      knownQuoteTweets: 0,
      ownTweetsChecked: 0,
      staleQuoteTweets: 0,
      giveawayIgnoredTweets: 0,
      projectIgnoredTweets: 0,
      baselineQuoteTweets: 0,
      candidateQuoteTweets: 0,
      errors: 0
    };

    try {
      const tweets = await this.searchService.searchAccountWindow(maker.username, since, until, {
        maxPages: maxSearchPages,
        useServerTimeWindow
      });
      stats.foundTweets = tweets.length;

      for (const tweet of tweets) {
        if (tweet.isReply || tweet.isQuoteTweet || tweet.quotedTweet) {
          continue;
        }

        stats.ownTweetsChecked += 1;
        await this.evaluateOwnTweetTrend(tweet, skipAlertsThisCycle, pendingAlerts, stats);
      }
    } catch (error) {
      stats.errors += 1;
      logger.error("Failed to process trend maker", {
        username: maker.username,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return stats;
  }

  private async evaluateOwnTweetTrend(
    tweet: NormalizedTweet,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    stats: AccountPollStats
  ): Promise<void> {
    const checkedAt = new Date().toISOString();
    const tooOld = isOriginalTweetTooOld(tweet.createdAt, new Date(checkedAt), env.originalTweetMaxAgeHours);
    if (tooOld) {
      stats.staleQuoteTweets += 1;
      return;
    }

    const qualityFilter = this.qualityFilterService.evaluate(tweet);
    const storedOriginal = this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
      originalTweetId: tweet.id,
      originalAuthorUsername: tweet.author.username,
      originalText: tweet.text,
      originalUrl: tweet.url,
      originalCreatedAt: tweet.createdAt,
      firstSeenAt: checkedAt,
      checkedAt,
      isTooOld: false,
      metrics: tweet.metrics,
      originalAuthorFollowersCount: tweet.author.followersCount ?? null,
      ignoredReason: qualityFilter?.reason ?? null
    });

    if (qualityFilter) {
      this.incrementQualityFilterStats(stats, qualityFilter.reason);
      logger.info("Ignoring trend-maker tweet by quality filter", {
        originalTweetId: storedOriginal.originalTweetId,
        reason: qualityFilter.reason,
        matched: qualityFilter.matched
      });
      return;
    }

    if (skipAlertsThisCycle) {
      stats.baselineQuoteTweets += 1;
      return;
    }

    stats.candidateQuoteTweets += 1;
    if (this.trendRepositoryService.hasAlreadyBeenAlerted(storedOriginal.originalTweetId)) {
      logger.info("Skipping already alerted trend-maker tweet", {
        originalTweetId: storedOriginal.originalTweetId
      });
      return;
    }

    const triggeredSignals = this.trendRepositoryService.getTriggeredSignals(storedOriginal.originalTweetId);
    const result = this.trendScoringService.evaluateSignals({
      originalTweetId: storedOriginal.originalTweetId,
      currentMetrics: tweet.metrics,
      baselineQuoteCount: tweet.metrics.quoteCount,
      trackedQuoteCount: 0,
      alreadyTriggered: {
        a: triggeredSignals.includes("A"),
        b: true,
        c: triggeredSignals.includes("C")
      },
      originalAuthorUsername: tweet.author.username,
      originalText: tweet.text,
      originalUrl: tweet.url,
      originalAuthorFollowersCount: tweet.author.followersCount ?? storedOriginal.originalAuthorFollowersCount,
      mediaUrls: tweet.mediaUrls,
      trackedQuotes: []
    });

    if (result.payload && result.signals.length > 0) {
      this.addPendingAlert(pendingAlerts, {
        originalTweetId: storedOriginal.originalTweetId,
        signals: result.signals,
        payload: result.payload
      });
    }
  }

  private incrementQualityFilterStats(stats: AccountPollStats, reason: QualityIgnoreReason): void {
    if (reason === "giveaway") {
      stats.giveawayIgnoredTweets += 1;
      return;
    }

    stats.projectIgnoredTweets += 1;
  }

  private addPendingAlert(pendingAlerts: PendingTrendAlerts, alert: PendingTrendAlert): void {
    const existing = pendingAlerts.get(alert.originalTweetId);
    if (!existing) {
      pendingAlerts.set(alert.originalTweetId, alert);
      return;
    }

    const mergedSignals = [...new Set([...existing.signals, ...alert.signals])];
    const payload =
      alert.payload.trackedQuotes.length >= existing.payload.trackedQuotes.length
        ? alert.payload
        : existing.payload;

    pendingAlerts.set(alert.originalTweetId, {
      originalTweetId: alert.originalTweetId,
      signals: mergedSignals,
      payload: {
        ...payload,
        signals: mergedSignals
      }
    });
  }

  private async refreshRecentOriginalTweets(skipAlertsThisCycle: boolean, pendingAlerts: PendingTrendAlerts): Promise<void> {
    const recentOriginalTweets = originalTweetRepository.listTweetsNeedingGrowthChecks(4);

    for (const original of recentOriginalTweets) {
      try {
        const latest = await this.searchService.getTweetById(
          original.originalTweetId,
          original.originalAuthorUsername
        );
        if (!latest) {
          continue;
        }

        const trackedQuotes = this.trendRepositoryService.getTrackedQuotes(original.originalTweetId);
        const checkedAt = new Date().toISOString();
        this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
          originalTweetId: original.originalTweetId,
          originalAuthorUsername: latest.author.username,
          originalText: latest.text,
          originalUrl: latest.url,
          originalCreatedAt: latest.createdAt,
          firstSeenAt: original.firstSeenAt ?? original.firstDetectedAt,
          checkedAt,
          isTooOld: Boolean(original.isTooOld),
          metrics: latest.metrics
        });

        const triggeredSignals = this.trendRepositoryService.getTriggeredSignals(original.originalTweetId);
        if (skipAlertsThisCycle) {
          logger.info("Skipping refresh alerts on bootstrap cycle", {
            originalTweetId: original.originalTweetId
          });
          continue;
        }

        const oldestSnapshot = originalTweetRepository.getOldestSnapshotWithinWindow(original.originalTweetId, 4);
        const result = this.trendScoringService.evaluateSignals({
          originalTweetId: original.originalTweetId,
          currentMetrics: latest.metrics,
          baselineQuoteCount: oldestSnapshot?.quoteCount ?? latest.metrics.quoteCount,
          trackedQuoteCount: new Set(trackedQuotes.map((quote) => quote.trackedAccountUsername)).size,
          alreadyTriggered: {
            a: triggeredSignals.includes("A"),
            b: triggeredSignals.includes("B"),
            c: triggeredSignals.includes("C")
          },
          originalAuthorUsername: latest.author.username,
          originalText: latest.text,
          originalUrl: latest.url,
          originalAuthorFollowersCount: latest.author.followersCount ?? original.originalAuthorFollowersCount,
          mediaUrls: latest.mediaUrls,
          trackedQuotes
        });

        if (result.payload && result.signals.length > 0) {
          this.addPendingAlert(pendingAlerts, {
            originalTweetId: original.originalTweetId,
            signals: result.signals,
            payload: result.payload
          });
        }
      } catch (error) {
        logger.error("Failed to refresh original tweet", {
          originalTweetId: original.originalTweetId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
}

import { trackedAccountRepository, quoteRepository, originalTweetRepository } from "../../db/repositories";
import { env } from "../../config/env";
import { AdvancedSearchService } from "../twitter/advancedSearchService";
import { detectQuoteTweet, resolveRootOriginal } from "../twitter/quoteTweetDetector";
import { TweetByIdCache } from "../twitter/tweetByIdCache";
import { isOriginalTweetTooOld } from "./helpers";
import { TrendRepositoryService } from "./trendRepositoryService";
import { TrendScoringService } from "./trendScoringService";
import { TelegramService } from "../telegram/telegramService";
import { logger } from "../../utils/logger";
import {
  AccountPollStats,
  AlertPayload,
  CatcherQuoteReport,
  MakerPostReport,
  MakerTweetReport,
  TrendSignal
} from "../../types/trends";
import { NormalizedTweet } from "../../types/twitter";
import { listTrendMakers, TrendMakerConfigRecord } from "./trendMakerConfig";
import { QualityFilterService, QualityIgnoreReason } from "./qualityFilterService";

interface PendingTrendAlert {
  originalTweetId: string;
  signals: TrendSignal[];
  payload: AlertPayload;
}

type PendingTrendAlerts = Map<string, PendingTrendAlert>;

type AccountRole = "trend-catcher" | "trend-maker";

interface UnifiedAccountConfig {
  username: string;
  roles: AccountRole[];
  priority: number;
  trendMakerLookbackHours: number;
  trendMakerQuoteThreshold?: number;
}

const isWithinWindow = (tweet: NormalizedTweet, since: string, until: string): boolean => {
  if (!tweet.createdAt) {
    return false;
  }

  const createdAtMs = new Date(tweet.createdAt).getTime();
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();

  if (Number.isNaN(createdAtMs) || Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
    return false;
  }

  return createdAtMs >= sinceMs && createdAtMs < untilMs;
};

const buildTweetPreview = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(no text)";
  }

  if (normalized.length <= 48) {
    return normalized;
  }

  return `${normalized.slice(0, 45).trimEnd()}...`;
};

const formatIgnoredReason = (reason: string | null): string => (reason ? `yes | reason: ${reason}` : "no");

const isSelfQuote = (quoteAuthorUsername: string, quotedAuthorUsername: string): boolean => {
  return quoteAuthorUsername.trim().toLowerCase() === quotedAuthorUsername.trim().toLowerCase();
};

const getDistinctTrackedQuoteAuthorsCount = (trackedQuotes: Array<{ trackedAccountUsername: string }>): number => {
  return new Set(trackedQuotes.map((quote) => quote.trackedAccountUsername.toLowerCase())).size;
};

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
    const requestedUsernames = options?.accountUsernames?.map((username) => username.toLowerCase());
    const trackedAccounts = this.getUnifiedAccountConfigs().filter(
      (account) => !requestedUsernames || requestedUsernames.includes(account.username.toLowerCase())
    );
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
    const tweetByIdCache = new TweetByIdCache(this.searchService);
    const queue = [...trackedAccounts];
    const concurrency = Math.min(env.pollConcurrency, trackedAccounts.length || 1);
    const workers = Array.from({ length: concurrency }, async () => {
      while (queue.length > 0) {
        const account = queue.shift();
        if (!account) {
          return;
        }
        const stats = await this.processUnifiedAccount(
          account.username,
          account.roles,
          account.trendMakerLookbackHours,
          account.trendMakerQuoteThreshold,
          since,
          until,
          skipAlertsThisCycle,
          pendingAlerts,
          tweetByIdCache,
          options?.maxSearchPages,
          options?.useServerTimeWindow
        );
        accountStats.push(stats);
      }
    });

    await Promise.all(workers);

    if (env.enableSignalA && !options?.skipRefresh) {
      await this.refreshRecentOriginalTweets(skipAlertsThisCycle, pendingAlerts);
    }

    if (env.sendPollReports) {
      const reportPayload = {
        since,
        until,
        accounts: accountStats.sort((a, b) => a.username.localeCompare(b.username)),
        trendAlertsCount: pendingAlerts.size,
        skipAlertsThisCycle
      };

      try {
        await this.telegramService.sendPollReport(reportPayload);
      } catch (error) {
        logger.error("Failed to send poll report", {
          error: error instanceof Error ? error.message : String(error)
        });
      }

      try {
        await this.telegramService.sendDetailedReport(reportPayload);
      } catch (error) {
        logger.error("Failed to send detailed report", {
          error: error instanceof Error ? error.message : String(error)
        });
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

  private getUnifiedAccountConfigs(): UnifiedAccountConfig[] {
    const merged = new Map<string, UnifiedAccountConfig>();

    for (const account of trackedAccountRepository.listActive()) {
      const key = account.username.toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.roles = [...new Set([...existing.roles, "trend-catcher"])] as AccountRole[];
        existing.priority = Math.min(existing.priority, account.priority);
        continue;
      }

      merged.set(key, {
        username: account.username,
        roles: ["trend-catcher"],
        priority: account.priority,
        trendMakerLookbackHours: 0
      });
    }

    for (const maker of listTrendMakers()) {
      const key = maker.username.toLowerCase();
      const existing = merged.get(key);
      if (existing) {
        existing.roles = [...new Set([...existing.roles, "trend-maker"])] as AccountRole[];
        existing.priority = Math.min(existing.priority, maker.priority);
        existing.trendMakerLookbackHours = Math.max(existing.trendMakerLookbackHours, maker.lookbackHours);
        existing.trendMakerQuoteThreshold = maker.quoteThreshold ?? existing.trendMakerQuoteThreshold;
        continue;
      }

      merged.set(key, {
        username: maker.username,
        roles: ["trend-maker"],
        priority: maker.priority,
        trendMakerLookbackHours: maker.lookbackHours,
        trendMakerQuoteThreshold: maker.quoteThreshold
      });
    }

    return [...merged.values()].sort((a, b) => a.priority - b.priority || a.username.localeCompare(b.username));
  }

  private async processUnifiedAccount(
    username: string,
    roles: AccountRole[],
    trendMakerLookbackHours: number,
    trendMakerQuoteThreshold: number | undefined,
    since: string,
    until: string,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    tweetByIdCache: TweetByIdCache,
    maxSearchPages?: number,
    useServerTimeWindow?: boolean
  ): Promise<AccountPollStats> {
    const makerSince = roles.includes("trend-maker")
      ? new Date(new Date(until).getTime() - trendMakerLookbackHours * 60 * 60 * 1000).toISOString()
      : null;
    const fetchSince =
      makerSince && new Date(makerSince).getTime() < new Date(since).getTime() ? makerSince : since;

    const stats: AccountPollStats = {
      username,
      roles,
      foundTweets: 0,
      newQuoteTweets: 0,
      knownQuoteTweets: 0,
      ownTweetsChecked: 0,
      staleQuoteTweets: 0,
      giveawayIgnoredTweets: 0,
      projectIgnoredTweets: 0,
      alreadyAlertedTweets: 0,
      ignoredQuoteTweetUrl: null,
      catcherQuoteReports: [],
      makerTweetReports: [],
      makerDetailedReports: [],
      baselineQuoteTweets: 0,
      candidateQuoteTweets: 0,
      errors: 0
    };

    try {
      const tweets = await this.searchService.searchAccountWindow(username, fetchSince, until, {
        maxPages: maxSearchPages,
        useServerTimeWindow
      });
      stats.foundTweets = tweets.length;
      logger.info("Fetched tweets for unified account", {
        username,
        roles,
        count: tweets.length,
        since: fetchSince,
        until
      });

      for (const tweet of tweets) {
        if (roles.includes("trend-catcher") && isWithinWindow(tweet, since, until)) {
          await this.processCatcherTweet(
            tweet,
            username,
            skipAlertsThisCycle,
            pendingAlerts,
            tweetByIdCache,
            stats
          );
        }

        if (roles.includes("trend-maker") && makerSince && isWithinWindow(tweet, makerSince, until)) {
          const isQuoteLike = tweet.isReply || tweet.isQuoteTweet || tweet.quotedTweet;
          if (isQuoteLike) {
            if (!roles.includes("trend-catcher")) {
              await this.processCatcherTweet(
                tweet,
                username,
                skipAlertsThisCycle,
                pendingAlerts,
                tweetByIdCache,
                stats
              );
            }
            continue;
          }

          await this.processTrendMakerTweet(tweet, skipAlertsThisCycle, pendingAlerts, stats, trendMakerQuoteThreshold);
        }
      }
    } catch (error) {
      stats.errors += 1;
      logger.error("Failed to process unified account", {
        username,
        roles,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    return stats;
  }

  private async processCatcherTweet(
    tweet: NormalizedTweet,
    username: string,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    tweetByIdCache: TweetByIdCache,
    stats: AccountPollStats
  ): Promise<void> {
    const report: CatcherQuoteReport = {
      quoteTweetUrl: tweet.url,
      ignoredReason: null
    };

    const quoteKnown = quoteRepository.isQuoteTweetKnown(tweet.id);
    if (quoteKnown) {
      stats.knownQuoteTweets += 1;
    }

    const detection = detectQuoteTweet(tweet);
    if (!detection) {
      if (tweet.isQuoteTweet) {
        report.ignoredReason = "quote not resolved";
        stats.catcherQuoteReports.push(report);
      }
      return;
    }
    stats.newQuoteTweets += 1;
    report.quoteTweetUrl = detection.quoteTweet.url;

    const resolved = await resolveRootOriginal(detection, tweetByIdCache);
    if (resolved.chain.length > 0) {
      logger.info("Resolved nested catcher quote chain", {
        quoteTweetId: detection.quoteTweet.id,
        rootOriginalTweetId: resolved.originalTweet.id,
        chain: resolved.chain
      });
    }

    if (!resolved.resolved) {
      logger.info("Unable to resolve catcher quote tweet", {
        quoteTweetId: detection.quoteTweet.id,
        quoteTweetUrl: detection.quoteTweet.url
      });
      report.ignoredReason = "quote not resolved";
      stats.catcherQuoteReports.push(report);
      return;
    }

    const rootOriginalTweet = resolved.originalTweet;

    if (isSelfQuote(detection.quoteTweet.author.username, detection.originalTweet.author.username)) {
      logger.info("Ignoring self quote tweet", {
        quoteTweetId: detection.quoteTweet.id,
        quoteAuthorUsername: detection.quoteTweet.author.username,
        quotedTweetId: detection.originalTweet.id,
        quotedTweetAuthorUsername: detection.originalTweet.author.username,
        rootOriginalTweetId: rootOriginalTweet.id,
        rootOriginalAuthorUsername: rootOriginalTweet.author.username
      });
      report.ignoredReason = "self quote";
      stats.catcherQuoteReports.push(report);
      return;
    }

    const detectedAt = new Date().toISOString();
    const tooOld = isOriginalTweetTooOld(
      rootOriginalTweet.createdAt,
      new Date(detectedAt),
      env.originalTweetMaxAgeHours
    );

    const storedOriginal = this.trendRepositoryService.saveDetectedQuote({
      trackedAccountUsername: username,
      detectedAt,
      quoteTweet: detection.quoteTweet,
      originalTweet: rootOriginalTweet
    });

    if (tooOld) {
      this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
        originalTweetId: storedOriginal.originalTweetId,
        originalAuthorUsername: rootOriginalTweet.author.username,
        originalText: rootOriginalTweet.text,
        originalUrl: rootOriginalTweet.url,
        originalCreatedAt: rootOriginalTweet.createdAt,
        firstSeenAt: detectedAt,
        checkedAt: detectedAt,
        isTooOld: true,
        metrics: rootOriginalTweet.metrics,
        ignoredReason: "too_old"
      });
      logger.info("Ignoring stale original tweet", {
        originalTweetId: storedOriginal.originalTweetId,
        originalCreatedAt: rootOriginalTweet.createdAt
      });
      stats.staleQuoteTweets += 1;
      stats.ignoredQuoteTweetUrl = detection.quoteTweet.url;
      report.ignoredReason = "old post";
      stats.catcherQuoteReports.push(report);
      return;
    }

    const trackedQuotes = this.trendRepositoryService.getTrackedQuotes(storedOriginal.originalTweetId);
    const distinctTrackedQuoteAuthors = getDistinctTrackedQuoteAuthorsCount(trackedQuotes);
    if (distinctTrackedQuoteAuthors < env.signalBMinTrackedQuotes) {
      logger.info("Skipping quote tweet due to insufficient distinct tracked authors", {
        originalTweetId: storedOriginal.originalTweetId,
        distinctTrackedQuoteAuthors,
        requiredDistinctTrackedQuoteAuthors: env.signalBMinTrackedQuotes
      });
      report.ignoredReason = "not enough distinct tracked quotes";
      stats.catcherQuoteReports.push(report);
      return;
    }
    const baselineCheckedAt = detectedAt;
    this.trendRepositoryService.markOriginalTweetAsSeenWithoutAlert({
      originalTweetId: storedOriginal.originalTweetId,
      originalAuthorUsername: rootOriginalTweet.author.username,
      originalText: rootOriginalTweet.text,
      originalUrl: rootOriginalTweet.url,
      originalCreatedAt: rootOriginalTweet.createdAt,
      firstSeenAt: baselineCheckedAt,
      checkedAt: baselineCheckedAt,
      isTooOld: false,
      metrics: rootOriginalTweet.metrics
    });

    const qualityFilter = this.qualityFilterService.evaluate(rootOriginalTweet);
    if (qualityFilter) {
      this.trendRepositoryService.markOriginalTweetIgnored(storedOriginal.originalTweetId, qualityFilter.reason);
      this.incrementQualityFilterStats(stats, qualityFilter.reason);
      stats.ignoredQuoteTweetUrl = detection.quoteTweet.url;
      logger.info("Ignoring original tweet by quality filter", {
        originalTweetId: storedOriginal.originalTweetId,
        reason: qualityFilter.reason,
        matched: qualityFilter.matched
      });
      report.ignoredReason = qualityFilter.reason;
      stats.catcherQuoteReports.push(report);
      return;
    }

    if (skipAlertsThisCycle) {
      logger.info("Skipping alerts on bootstrap cycle", {
        originalTweetId: storedOriginal.originalTweetId
      });
      stats.baselineQuoteTweets += 1;
      report.ignoredReason = "bootstrap";
      stats.catcherQuoteReports.push(report);
      return;
    }

    stats.candidateQuoteTweets += 1;
    if (this.trendRepositoryService.hasAlreadyBeenAlerted(storedOriginal.originalTweetId)) {
      logger.info("Skipping already alerted original tweet", {
        originalTweetId: storedOriginal.originalTweetId
      });
      stats.alreadyAlertedTweets += 1;
      stats.ignoredQuoteTweetUrl = detection.quoteTweet.url;
      report.ignoredReason = "already sent";
      stats.catcherQuoteReports.push(report);
      return;
    }

    const triggeredSignals = this.trendRepositoryService.getTriggeredSignals(storedOriginal.originalTweetId);
    const oldestSnapshot = originalTweetRepository.getOldestSnapshotWithinWindow(storedOriginal.originalTweetId, 4);
    const result = this.trendScoringService.evaluateSignals({
      originalTweetId: storedOriginal.originalTweetId,
      currentMetrics: rootOriginalTweet.metrics,
      baselineQuoteCount: oldestSnapshot?.quoteCount ?? rootOriginalTweet.metrics.quoteCount,
      trackedQuoteCount: new Set(trackedQuotes.map((quote) => quote.trackedAccountUsername)).size,
      alreadyTriggered: {
        a: triggeredSignals.includes("A"),
        b: triggeredSignals.includes("B"),
        c: triggeredSignals.includes("C")
      },
      originalAuthorUsername: rootOriginalTweet.author.username,
      originalText: rootOriginalTweet.text,
      originalUrl: rootOriginalTweet.url,
      originalAuthorFollowersCount: rootOriginalTweet.author.followersCount ?? storedOriginal.originalAuthorFollowersCount,
      mediaUrls: rootOriginalTweet.mediaUrls,
      trackedQuotes
    });

    const hasNestedQuoteChain = resolved.chain.length > 0;
    const shouldAlert = Boolean(result.payload && result.signals.length > 0);
    const nestedChainAlert = hasNestedQuoteChain && !shouldAlert;
    if (nestedChainAlert) {
      logger.info("Triggering nested quote-chain alert", {
        originalTweetId: storedOriginal.originalTweetId,
        quoteTweetId: detection.quoteTweet.id,
        chain: resolved.chain
      });
      this.addPendingAlert(pendingAlerts, {
        originalTweetId: storedOriginal.originalTweetId,
        signals: ["C"],
        payload: {
          originalAuthorUsername: rootOriginalTweet.author.username,
          originalText: rootOriginalTweet.text,
          originalUrl: rootOriginalTweet.url,
          originalAuthorFollowersCount: rootOriginalTweet.author.followersCount ?? storedOriginal.originalAuthorFollowersCount,
          metrics: rootOriginalTweet.metrics,
          mediaUrls: rootOriginalTweet.mediaUrls,
          signals: ["C"],
          trackedQuotes
        }
      });
    }

    const finalShouldAlert = shouldAlert || nestedChainAlert;
    report.ignoredReason = finalShouldAlert ? null : quoteKnown ? "already seen" : "not enough quotes";
    stats.catcherQuoteReports.push(report);

    if (shouldAlert && result.payload) {
      this.addPendingAlert(pendingAlerts, {
        originalTweetId: storedOriginal.originalTweetId,
        signals: result.signals,
        payload: result.payload
      });
    }
  }

  private async processTrendMakerTweet(
    tweet: NormalizedTweet,
    skipAlertsThisCycle: boolean,
    pendingAlerts: PendingTrendAlerts,
    stats: AccountPollStats,
    quoteThreshold?: number
  ): Promise<void> {
    stats.ownTweetsChecked += 1;
    const checkedAt = new Date().toISOString();
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
      originalAuthorFollowersCount: tweet.author.followersCount ?? null
    });

    const detailedReport: MakerPostReport = {
      tweetUrl: tweet.url,
      quoteCount: tweet.metrics.quoteCount,
      isNewPost: storedOriginal.firstDetectedAt === checkedAt,
      ignoredReason: null
    };

    if (!this.trendRepositoryService.shouldEmitMakerTweetReport(storedOriginal.originalTweetId, tweet.metrics.quoteCount, checkedAt)) {
      detailedReport.ignoredReason = "not enough quotes";
      stats.makerDetailedReports.push(detailedReport);
      return;
    }

    const report: MakerTweetReport = {
      tweetPreview: buildTweetPreview(tweet.text),
      tweetUrl: tweet.url,
      quoteCount: tweet.metrics.quoteCount,
      alertSent: false,
      ignoredReason: null
    };

    if (skipAlertsThisCycle) {
      stats.baselineQuoteTweets += 1;
      stats.makerTweetReports.push(report);
      detailedReport.ignoredReason = "bootstrap";
      stats.makerDetailedReports.push(detailedReport);
      return;
    }

    stats.candidateQuoteTweets += 1;
    if (this.trendRepositoryService.hasAlreadyBeenAlerted(storedOriginal.originalTweetId)) {
      logger.info("Skipping already alerted trend-maker tweet", {
        originalTweetId: storedOriginal.originalTweetId
      });
      report.ignoredReason = "already sent";
      stats.makerTweetReports.push(report);
      detailedReport.ignoredReason = "already sent";
      stats.makerDetailedReports.push(detailedReport);
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
      signalCQuoteThreshold: quoteThreshold,
      mediaUrls: tweet.mediaUrls,
      trackedQuotes: []
    });

    report.alertSent = Boolean(result.payload && result.signals.length > 0);
    stats.makerTweetReports.push(report);
    detailedReport.ignoredReason = result.payload && result.signals.length > 0 ? null : "not enough quotes";
    stats.makerDetailedReports.push(detailedReport);

    if (result.payload && result.signals.length > 0) {
      this.addPendingAlert(pendingAlerts, {
        originalTweetId: storedOriginal.originalTweetId,
        signals: result.signals,
        payload: result.payload
      });
    }
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
      roles: ["trend-catcher"],
      foundTweets: 0,
      newQuoteTweets: 0,
      knownQuoteTweets: 0,
      ownTweetsChecked: 0,
      staleQuoteTweets: 0,
      giveawayIgnoredTweets: 0,
      projectIgnoredTweets: 0,
      alreadyAlertedTweets: 0,
      ignoredQuoteTweetUrl: null,
      catcherQuoteReports: [],
      makerTweetReports: [],
      makerDetailedReports: [],
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
        const quoteKnown = quoteRepository.isQuoteTweetKnown(tweet.id);
        if (quoteKnown) {
          stats.knownQuoteTweets += 1;
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
        const distinctTrackedQuoteAuthors = getDistinctTrackedQuoteAuthorsCount(trackedQuotes);
        if (distinctTrackedQuoteAuthors < env.signalBMinTrackedQuotes) {
          logger.info("Skipping tracked account quote tweet due to insufficient distinct tracked authors", {
            originalTweetId: storedOriginal.originalTweetId,
            distinctTrackedQuoteAuthors,
            requiredDistinctTrackedQuoteAuthors: env.signalBMinTrackedQuotes
          });
          continue;
        }
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
          stats.alreadyAlertedTweets += 1;
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
      roles: ["trend-maker"],
      foundTweets: 0,
      newQuoteTweets: 0,
      knownQuoteTweets: 0,
      ownTweetsChecked: 0,
      staleQuoteTweets: 0,
      giveawayIgnoredTweets: 0,
      projectIgnoredTweets: 0,
      alreadyAlertedTweets: 0,
      ignoredQuoteTweetUrl: null,
      catcherQuoteReports: [],
      makerTweetReports: [],
      makerDetailedReports: [],
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
        await this.evaluateOwnTweetTrend(tweet, skipAlertsThisCycle, pendingAlerts, stats, maker.quoteThreshold);
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
    stats: AccountPollStats,
    quoteThreshold?: number
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
    const detailedReport: MakerPostReport = {
      tweetUrl: tweet.url,
      quoteCount: tweet.metrics.quoteCount,
      isNewPost: storedOriginal.firstDetectedAt === checkedAt,
      ignoredReason: null
    };

    if (qualityFilter) {
      this.incrementQualityFilterStats(stats, qualityFilter.reason);
      logger.info("Ignoring trend-maker tweet by quality filter", {
        originalTweetId: storedOriginal.originalTweetId,
        reason: qualityFilter.reason,
        matched: qualityFilter.matched
      });
      stats.makerTweetReports.push({
        tweetPreview: buildTweetPreview(tweet.text),
        tweetUrl: tweet.url,
        quoteCount: tweet.metrics.quoteCount,
        alertSent: false,
        ignoredReason: qualityFilter.reason
      });
      detailedReport.ignoredReason = qualityFilter.reason;
      stats.makerDetailedReports.push(detailedReport);
      return;
    }

    if (skipAlertsThisCycle) {
      stats.baselineQuoteTweets += 1;
      stats.makerTweetReports.push({
        tweetPreview: buildTweetPreview(tweet.text),
        tweetUrl: tweet.url,
        quoteCount: tweet.metrics.quoteCount,
        alertSent: false,
        ignoredReason: "bootstrap"
      });
      detailedReport.ignoredReason = "bootstrap";
      stats.makerDetailedReports.push(detailedReport);
      return;
    }

    stats.candidateQuoteTweets += 1;
    if (this.trendRepositoryService.hasAlreadyBeenAlerted(storedOriginal.originalTweetId)) {
      logger.info("Skipping already alerted trend-maker tweet", {
        originalTweetId: storedOriginal.originalTweetId
      });
      stats.alreadyAlertedTweets += 1;
      stats.makerTweetReports.push({
        tweetPreview: buildTweetPreview(tweet.text),
        tweetUrl: tweet.url,
        quoteCount: tweet.metrics.quoteCount,
        alertSent: false,
        ignoredReason: "already sent"
      });
      detailedReport.ignoredReason = "already sent";
      stats.makerDetailedReports.push(detailedReport);
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

    stats.makerTweetReports.push({
      tweetPreview: buildTweetPreview(tweet.text),
      tweetUrl: tweet.url,
      quoteCount: tweet.metrics.quoteCount,
      alertSent: Boolean(result.payload && result.signals.length > 0),
      ignoredReason: result.payload && result.signals.length > 0 ? null : "not enough quotes"
    });
    detailedReport.ignoredReason = result.payload && result.signals.length > 0 ? null : "not enough quotes";
    stats.makerDetailedReports.push(detailedReport);

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
    const recentOriginalTweets = originalTweetRepository.listTweetsNeedingGrowthChecks(env.ownTweetLookbackHours);

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
        const distinctTrackedQuoteAuthors = getDistinctTrackedQuoteAuthorsCount(trackedQuotes);
        if (distinctTrackedQuoteAuthors < env.signalBMinTrackedQuotes) {
          logger.info("Skipping refresh alert due to insufficient distinct tracked authors", {
            originalTweetId: original.originalTweetId,
            distinctTrackedQuoteAuthors,
            requiredDistinctTrackedQuoteAuthors: env.signalBMinTrackedQuotes
          });
          continue;
        }
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

        const oldestSnapshot = originalTweetRepository.getOldestSnapshotWithinWindow(
          original.originalTweetId,
          env.ownTweetLookbackHours
        );
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

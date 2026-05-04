import { env } from "./config/env";
import { getDb } from "./db/database";
import { trackedAccountRepository } from "./db/repositories";
import { PollingScheduler } from "./jobs/pollingScheduler";
import { TelegramService } from "./services/telegram/telegramService";
import { DailySummaryService } from "./services/trends/dailySummaryService";
import { TrendMonitorService } from "./services/trends/trendMonitorService";
import { TrendRepositoryService } from "./services/trends/trendRepositoryService";
import { TrendScoringService } from "./services/trends/trendScoringService";
import { AdvancedSearchService } from "./services/twitter/advancedSearchService";
import { TwitterApiClient } from "./services/twitter/client";
import { logger } from "./utils/logger";

const createServices = (): {
  trendMonitorService: TrendMonitorService;
  dailySummaryService: DailySummaryService;
} => {
  const twitterClient = new TwitterApiClient();
  const searchService = new AdvancedSearchService(twitterClient);
  const telegramService = new TelegramService();
  const trendRepositoryService = new TrendRepositoryService();
  const trendScoringService = new TrendScoringService();
  const trendMonitorService = new TrendMonitorService(
    searchService,
    trendRepositoryService,
    trendScoringService,
    telegramService
  );
  const dailySummaryService = new DailySummaryService(searchService, telegramService);

  return { trendMonitorService, dailySummaryService };
};

const runTestScan = async (): Promise<void> => {
  const until = new Date();
  until.setSeconds(0, 0);
  const since = new Date(until.getTime() - env.testScanHours * 60 * 60 * 1000);
  const { trendMonitorService } = createServices();
  const accountUsernames = env.testScanAccount ? [env.testScanAccount] : undefined;

  logger.info("Running manual test scan", {
    since: since.toISOString(),
    until: until.toISOString(),
    dryRun: env.dryRun,
    skipAlertsOnFirstRun: env.skipAlertsOnFirstRun,
    testScanHours: env.testScanHours,
    testScanMaxPages: env.testScanMaxPages,
    accountUsernames,
    testUseServerTimeWindow: env.testUseServerTimeWindow
  });

  await trendMonitorService.pollWindow(since.toISOString(), until.toISOString(), {
    accountUsernames,
    maxSearchPages: env.testScanMaxPages,
    skipRefresh: true,
    useServerTimeWindow: env.testUseServerTimeWindow
  });
};

const bootstrap = async (): Promise<void> => {
  getDb();
  const trackedAccounts = trackedAccountRepository.listActive();

  logger.info("CT Trend Hunter starting", {
    timezone: env.timezone,
    dryRun: env.dryRun,
    trackedAccounts: trackedAccounts.length
  });

  if (process.argv.includes("--test-scan")) {
    await runTestScan();
    return;
  }

  const { trendMonitorService, dailySummaryService } = createServices();

  const scheduler = new PollingScheduler(trendMonitorService, dailySummaryService);
  scheduler.start();

  process.on("SIGINT", () => {
    logger.info("Received SIGINT, shutting down");
    scheduler.stop();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    logger.info("Received SIGTERM, shutting down");
    scheduler.stop();
    process.exit(0);
  });
};

bootstrap().catch((error) => {
  logger.error("Fatal bootstrap error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});

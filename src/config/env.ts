import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const requireString = (name: string, value?: string): string => {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const parseNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return value;
};

const parseBoolean = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
};

export const env = {
  twitterApiKey: process.env.TWITTERAPI_IO_KEY,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID,
  telegramLogChatId: process.env.TELEGRAM_LOG_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID,
  timezone: process.env.TIMEZONE ?? "Europe/Moscow",
  workStartHour: parseNumber("WORK_START_HOUR", 10),
  workEndHour: parseNumber("WORK_END_HOUR", 17),
  pollMinutes: parseNumber("POLL_MINUTES", 30),
  morningCatchupSinceHour: parseNumber("MORNING_CATCHUP_SINCE_HOUR", 6),
  advancedSearchMaxPages: parseNumber("ADVANCED_SEARCH_MAX_PAGES", 1),
  useServerTimeWindow: parseBoolean("USE_SERVER_TIME_WINDOW", true),
  trendMakersFile: path.resolve(process.cwd(), process.env.TREND_MAKERS_FILE ?? "./trend_makers.json"),
  ownTweetLookbackHours: parseNumber("OWN_TWEET_LOOKBACK_HOURS", 2),

  // Signal C — tiered thresholds by author follower count
  signalCMinQuotes: parseNumber("SIGNAL_C_MIN_QUOTES", 10),
  signalCTierSmallMax: parseNumber("SIGNAL_C_TIER_SMALL_MAX", 5_000),
  signalCTierMediumMax: parseNumber("SIGNAL_C_TIER_MEDIUM_MAX", 20_000),
  signalCQuotesSmall: parseNumber("SIGNAL_C_QUOTES_SMALL", 5),
  signalCQuotesMedium: parseNumber("SIGNAL_C_QUOTES_MEDIUM", 10),
  signalCQuotesLarge: parseNumber("SIGNAL_C_QUOTES_LARGE", 15),
  pollConcurrency: parseNumber("POLL_CONCURRENCY", 3),

  signalBMinTrackedQuotes: parseNumber("SIGNAL_B_MIN_TRACKED_QUOTES", 2),
  signalAMinQuoteGrowth: parseNumber("SIGNAL_A_MIN_QUOTE_GROWTH", 3),
  enableSignalA: parseBoolean("ENABLE_SIGNAL_A", false),
  originalTweetMaxAgeHours: parseNumber("ORIGINAL_TWEET_MAX_AGE_HOURS", 48),
  enableQualityFilters: parseBoolean("ENABLE_QUALITY_FILTERS", true),
  qualityFiltersFile: path.resolve(process.cwd(), process.env.QUALITY_FILTERS_FILE ?? "./quality_filters.json"),
  projectAccountsFile: path.resolve(process.cwd(), process.env.PROJECT_ACCOUNTS_FILE ?? "./project_accounts.json"),
  skipAlertsOnFirstRun: parseBoolean("SKIP_ALERTS_ON_FIRST_RUN", true),
  sendPollReports: parseBoolean("SEND_POLL_REPORTS", false),
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? "./data/ct-trend-hunter.sqlite"),
  trackedAccountsFile: path.resolve(process.cwd(), process.env.TRACKED_ACCOUNTS_FILE ?? "./tracked_accounts.json"),
  dryRun: parseBoolean("DRY_RUN", false),
  logLevel: process.env.LOG_LEVEL ?? "info",
  httpTimeoutMs: parseNumber("HTTP_TIMEOUT_MS", 20_000),
  httpRetryAttempts: parseNumber("HTTP_RETRY_ATTEMPTS", 3),

  // Circuit breaker
  circuitFailureThreshold: parseNumber("CIRCUIT_FAILURE_THRESHOLD", 5),
  circuitCooldownMs: parseNumber("CIRCUIT_COOLDOWN_MS", 15 * 60 * 1000),

  // Bootstrap / catchup
  bootstrapGapMinutes: parseNumber("BOOTSTRAP_GAP_MINUTES", 15),

  // Alert queue
  alertQueueMaxAttempts: parseNumber("ALERT_QUEUE_MAX_ATTEMPTS", 10),

  // Cleanup retention
  snapshotRetentionDays: parseNumber("SNAPSHOT_RETENTION_DAYS", 7),
  tweetsRetentionDays: parseNumber("TWEETS_RETENTION_DAYS", 30),

  // Nested quote unwrap depth
  nestedQuoteMaxDepth: parseNumber("NESTED_QUOTE_MAX_DEPTH", 3),

  // Testing flags
  testMode: parseBoolean("TEST_MODE", false),
  testThresholds: parseBoolean("SIGNAL_TEST_THRESHOLDS", false),
  testPollMinutes: parseNumber("TEST_POLL_MINUTES", 1),
  testScanHours: parseNumber("TEST_SCAN_HOURS", 1),
  testScanMaxPages: parseNumber("TEST_SCAN_MAX_PAGES", 1),
  testScanAccount: process.env.TEST_SCAN_ACCOUNT?.trim() || null,
  testUseServerTimeWindow: parseBoolean("TEST_USE_SERVER_TIME_WINDOW", false)
};

export type AppConfig = typeof env;

export const requireTwitterConfig = (): { twitterApiKey: string } => ({
  twitterApiKey: requireString("TWITTERAPI_IO_KEY", env.twitterApiKey)
});

export const requireTelegramConfig = (): {
  telegramBotToken: string;
  telegramAlertChatId: string;
  telegramLogChatId: string;
} => ({
  telegramBotToken: requireString("TELEGRAM_BOT_TOKEN", env.telegramBotToken),
  telegramAlertChatId: requireString("TELEGRAM_ALERT_CHAT_ID", env.telegramAlertChatId),
  telegramLogChatId: requireString("TELEGRAM_LOG_CHAT_ID", env.telegramLogChatId)
});

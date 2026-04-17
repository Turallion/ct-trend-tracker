import { TwitterMetrics } from "./twitter";

export type TrendSignal = "A" | "B" | "C";

export interface StoredOriginalTweet {
  originalTweetId: string;
  originalAuthorUsername: string;
  originalText: string;
  originalUrl: string;
  firstSeenAt: string | null;
  firstDetectedAt: string;
  originalCreatedAt: string | null;
  isTooOld: boolean;
  ignoredReason: string | null;
  currentQuoteCount: number;
  currentLikeCount: number;
  currentReplyCount: number;
  currentViewCount: number;
  originalAuthorFollowersCount: number | null;
  alertSent: boolean;
  alertSentAt: string | null;
  lastSignalSent: string | null;
  signalATriggered: boolean;
  signalBTriggered: boolean;
  signalCTriggered: boolean;
}

export interface PendingAlertRecord {
  id: number;
  originalTweetId: string;
  payloadJson: string;
  signals: string;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  status: "pending" | "sent" | "failed";
}

export interface TrackedAccountQuote {
  trackedAccountUsername: string;
  quoteTweetId: string;
  detectedAt: string;
  quoteTweetUrl: string;
}

export interface TrendEvaluationContext {
  originalTweet: StoredOriginalTweet;
  metrics: TwitterMetrics;
  trackedQuotes: TrackedAccountQuote[];
  snapshotGrowth: number;
}

export interface AlertPayload {
  originalAuthorUsername: string;
  originalText: string;
  originalUrl: string;
  originalAuthorFollowersCount?: number | null;
  metrics: TwitterMetrics;
  mediaUrls?: string[];
  signals: TrendSignal[];
  trackedQuotes: TrackedAccountQuote[];
}

export interface MakerTweetReport {
  tweetUrl: string;
  quoteCount: number;
  alertSent: boolean;
  ignoredReason: string | null;
}

export interface AccountPollStats {
  username: string;
  roles: Array<"trend-catcher" | "trend-maker">;
  foundTweets: number;
  newQuoteTweets: number;
  knownQuoteTweets: number;
  ownTweetsChecked: number;
  staleQuoteTweets: number;
  giveawayIgnoredTweets: number;
  projectIgnoredTweets: number;
  alreadyAlertedTweets: number;
  ignoredQuoteTweetUrl: string | null;
  makerTweetReports: MakerTweetReport[];
  baselineQuoteTweets: number;
  candidateQuoteTweets: number;
  errors: number;
}

export interface PollReportPayload {
  since: string;
  until: string;
  accounts: AccountPollStats[];
  trendAlertsCount: number;
  skipAlertsThisCycle: boolean;
}

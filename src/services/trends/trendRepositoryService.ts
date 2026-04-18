import { quoteRepository, originalTweetRepository } from "../../db/repositories";
import { NormalizedTweet } from "../../types/twitter";
import { StoredOriginalTweet, TrackedAccountQuote } from "../../types/trends";

export class TrendRepositoryService {
  saveDetectedQuote(input: {
    trackedAccountUsername: string;
    detectedAt: string;
    quoteTweet: NormalizedTweet;
    originalTweet: NormalizedTweet;
  }): StoredOriginalTweet {
    quoteRepository.insertDetectedQuote({
      trackedAccountUsername: input.trackedAccountUsername,
      quoteTweetId: input.quoteTweet.id,
      originalTweetId: input.originalTweet.id,
      detectedAt: input.detectedAt,
      originalAuthorUsername: input.originalTweet.author.username,
      originalText: input.originalTweet.text,
      originalUrl: input.originalTweet.url
    });

    quoteRepository.linkTrackedAccountToOriginal({
      originalTweetId: input.originalTweet.id,
      trackedAccountUsername: input.trackedAccountUsername,
      quoteTweetId: input.quoteTweet.id,
      quoteTweetUrl: input.quoteTweet.url,
      detectedAt: input.detectedAt
    });

    const stored = originalTweetRepository.upsertOriginalTweet({
      originalTweetId: input.originalTweet.id,
      originalAuthorUsername: input.originalTweet.author.username,
      originalText: input.originalTweet.text,
      originalUrl: input.originalTweet.url,
      firstSeenAt: input.detectedAt,
      firstDetectedAt: input.detectedAt,
      originalCreatedAt: input.originalTweet.createdAt,
      isTooOld: false,
      metrics: input.originalTweet.metrics,
      originalAuthorFollowersCount: input.originalTweet.author.followersCount ?? null
    });

    return stored;
  }

  getTrackedQuotes(originalTweetId: string): TrackedAccountQuote[] {
    return quoteRepository.listTrackedQuotesForOriginal(originalTweetId);
  }

  markSignalsTriggered(originalTweetId: string, signals: Array<"A" | "B" | "C">): void {
    originalTweetRepository.updateSignalFlags(originalTweetId, signals);
  }

  markSignalsSeenWithoutAlert(originalTweetId: string, signals: Array<"A" | "B" | "C">): void {
    originalTweetRepository.updateSignalFlagsWithoutAlert(originalTweetId, signals);
  }

  markOriginalTweetIgnored(originalTweetId: string, reason: string): void {
    originalTweetRepository.markIgnored(originalTweetId, reason);
  }

  hasAlreadyBeenAlerted(originalTweetId: string): boolean {
    return originalTweetRepository.hasAlreadyBeenAlerted(originalTweetId);
  }

  getTriggeredSignals(originalTweetId: string): Array<"A" | "B" | "C"> {
    return originalTweetRepository.getTriggeredSignals(originalTweetId);
  }

  markOriginalTweetAsSeenWithoutAlert(input: {
    originalTweetId: string;
    originalAuthorUsername: string;
    originalText: string;
    originalUrl: string;
    originalCreatedAt?: string;
    firstSeenAt: string;
    checkedAt: string;
    isTooOld: boolean;
    metrics: NormalizedTweet["metrics"];
    originalAuthorFollowersCount?: number | null;
    ignoredReason?: string | null;
  }): StoredOriginalTweet {
    const stored = originalTweetRepository.upsertOriginalTweet({
      originalTweetId: input.originalTweetId,
      originalAuthorUsername: input.originalAuthorUsername,
      originalText: input.originalText,
      originalUrl: input.originalUrl,
      firstSeenAt: input.firstSeenAt,
      firstDetectedAt: input.checkedAt,
      originalCreatedAt: input.originalCreatedAt,
      isTooOld: input.isTooOld,
      ignoredReason: input.ignoredReason ?? null,
      metrics: input.metrics,
      originalAuthorFollowersCount: input.originalAuthorFollowersCount ?? null
    });

    originalTweetRepository.saveSnapshot(input.originalTweetId, input.checkedAt, input.metrics);
    return stored;
  }

  shouldEmitMakerTweetReport(originalTweetId: string, quoteCount: number, at: string): boolean {
    return originalTweetRepository.shouldEmitMakerTweetReport(originalTweetId, quoteCount, at);
  }
}

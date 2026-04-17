import { env } from "../../config/env";
import { AlertPayload, TrendSignal } from "../../types/trends";
import { TwitterMetrics } from "../../types/twitter";

const getSignalCQuoteThreshold = (followersCount: number | null | undefined): number => {
  if (followersCount == null) {
    return env.signalCMinQuotes;
  }

  if (followersCount < env.signalCTierSmallMax) {
    return env.signalCQuotesSmall;
  }

  if (followersCount <= env.signalCTierMediumMax) {
    return env.signalCQuotesMedium;
  }

  return env.signalCQuotesLarge;
};

export class TrendScoringService {
  evaluateSignals(input: {
    originalTweetId: string;
    currentMetrics: TwitterMetrics;
    baselineQuoteCount: number;
    trackedQuoteCount: number;
    alreadyTriggered: { a: boolean; b: boolean; c: boolean };
    originalAuthorUsername: string;
    originalText: string;
    originalUrl: string;
    originalAuthorFollowersCount?: number | null;
    mediaUrls?: string[];
    trackedQuotes: AlertPayload["trackedQuotes"];
  }): { signals: TrendSignal[]; payload?: AlertPayload } {
    const growth = input.currentMetrics.quoteCount - input.baselineQuoteCount;
    const signalCThreshold = getSignalCQuoteThreshold(input.originalAuthorFollowersCount);

    const signals: TrendSignal[] = [];

    if (!input.alreadyTriggered.c && input.currentMetrics.quoteCount >= signalCThreshold) {
      signals.push("C");
    }

    if (!input.alreadyTriggered.b && input.trackedQuoteCount >= env.signalBMinTrackedQuotes) {
      signals.push("B");
    }

    if (env.enableSignalA && !input.alreadyTriggered.a && growth >= env.signalAMinQuoteGrowth) {
      signals.push("A");
    }

    if (signals.length === 0) {
      return { signals: [] };
    }

    return {
      signals,
      payload: {
        originalAuthorUsername: input.originalAuthorUsername,
        originalText: input.originalText,
        originalUrl: input.originalUrl,
        originalAuthorFollowersCount: input.originalAuthorFollowersCount ?? null,
        metrics: input.currentMetrics,
        mediaUrls: input.mediaUrls ?? [],
        signals,
        trackedQuotes: input.trackedQuotes
      }
    };
  }
}

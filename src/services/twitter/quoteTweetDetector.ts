import { NormalizedTweet } from "../../types/twitter";
import { env } from "../../config/env";
import { TweetByIdCache } from "./tweetByIdCache";
import { logger } from "../../utils/logger";

export interface QuoteTweetDetection {
  quoteTweet: NormalizedTweet;
  originalTweet: NormalizedTweet;
  /** Intermediate tweet IDs between the quote and the root original. Empty if direct quote. */
  chain: string[];
  resolved: boolean;
}

/**
 * Synchronous detection: returns the immediate quoted tweet if present.
 * Used as a quick check before deciding whether to do async root unwrap.
 */
export const detectQuoteTweet = (tweet: NormalizedTweet): QuoteTweetDetection | null => {
  if (!tweet.isQuoteTweet) {
    return null;
  }

  return {
    quoteTweet: tweet,
    originalTweet: tweet.quotedTweet ?? tweet,
    chain: [],
    resolved: Boolean(tweet.quotedTweet)
  };
};

/**
 * Unwraps nested quote-of-quote chains to find the root original tweet.
 * Uses inline nested data first; falls back to getTweetById (via cache) if
 * the intermediate tweet indicates it is itself a quote but has no nested data.
 * Capped at env.nestedQuoteMaxDepth to prevent cycles.
 */
export const resolveRootOriginal = async (
  detection: QuoteTweetDetection,
  cache: TweetByIdCache
): Promise<QuoteTweetDetection> => {
  let current = detection.originalTweet;
  const chain: string[] = [];
  const seen = new Set<string>([detection.quoteTweet.id, current.id]);
  let resolved = detection.resolved;

  for (let depth = 0; depth < env.nestedQuoteMaxDepth; depth += 1) {
    // If there's inline nested data, follow it directly — no extra request.
    if (current.isQuoteTweet && current.quotedTweet) {
      chain.push(current.id);
      current = current.quotedTweet;
      resolved = true;
      if (seen.has(current.id)) {
        logger.warn("Quote chain cycle detected", { tweetId: current.id });
        break;
      }
      seen.add(current.id);
      continue;
    }

    // Marked as quote but no nested data — fetch once (cached).
    if (current.isQuoteTweet && !current.quotedTweet) {
      const fetched = await cache.fetch(current.id);
      if (!fetched || !fetched.quotedTweet) {
        resolved = false;
        break;
      }
      chain.push(current.id);
      current = fetched.quotedTweet;
      resolved = true;
      if (seen.has(current.id)) {
        logger.warn("Quote chain cycle detected", { tweetId: current.id });
        break;
      }
      seen.add(current.id);
      continue;
    }

    // Not a quote — reached the root.
    break;
  }

  if (chain.length > 0) {
    logger.info("Resolved nested quote chain", {
      quoteTweetId: detection.quoteTweet.id,
      rootOriginalTweetId: current.id,
      chain
    });
  }

  return {
    quoteTweet: detection.quoteTweet,
    originalTweet: current,
    chain,
    resolved
  };
};

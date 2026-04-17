import { NormalizedTweet } from "../../types/twitter";
import { AdvancedSearchService } from "./advancedSearchService";
import { logger } from "../../utils/logger";

/**
 * Per-cycle cache for getTweetById requests.
 * Instantiate at the start of each polling cycle; discard at end.
 * Prevents duplicate fetches for the same tweet ID within a single cycle
 * when unwrapping nested quote chains.
 */
export class TweetByIdCache {
  private readonly cache = new Map<string, NormalizedTweet | null>();

  constructor(private readonly searchService: AdvancedSearchService) {}

  async fetch(tweetId: string): Promise<NormalizedTweet | null> {
    if (this.cache.has(tweetId)) {
      return this.cache.get(tweetId) ?? null;
    }

    try {
      const tweet = await this.searchService.getTweetById(tweetId);
      this.cache.set(tweetId, tweet);
      return tweet;
    } catch (error) {
      logger.warn("TweetByIdCache: failed to fetch tweet", {
        tweetId,
        error: error instanceof Error ? error.message : String(error)
      });
      this.cache.set(tweetId, null);
      return null;
    }
  }
}

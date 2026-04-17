import { env } from "../../config/env";
import { TwitterApiClient } from "./client";
import { normalizeSearchResponse, normalizeTweet } from "./normalizers";
import { NormalizedTweet } from "../../types/twitter";
import { logger } from "../../utils/logger";

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

export class AdvancedSearchService {
  constructor(private readonly client: TwitterApiClient) {}

  async searchAccountWindow(
    username: string,
    since: string,
    until: string,
    options?: { maxPages?: number; useServerTimeWindow?: boolean }
  ): Promise<NormalizedTweet[]> {
    const useServerTimeWindow = options?.useServerTimeWindow ?? env.useServerTimeWindow;
    const sinceTime = Math.floor(new Date(since).getTime() / 1000);
    const untilTime = Math.floor(new Date(until).getTime() / 1000);
    const query = useServerTimeWindow
      ? `from:${username} -filter:replies since_time:${sinceTime} until_time:${untilTime}`
      : `from:${username} -filter:replies`;
    const matchedTweets: NormalizedTweet[] = [];
    const seenTweetIds = new Set<string>();
    let cursor: string | undefined;
    const maxPages = options?.maxPages ?? env.advancedSearchMaxPages;
    let pagesFetched = 0;
    let returnedTweets = 0;
    let duplicateTweets = 0;
    let replyTweets = 0;
    let outsideWindowTweets = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const data = useServerTimeWindow
        ? await this.client.advancedSearchWithTimeWindow(username, since, until, cursor)
        : await this.client.advancedSearch(query, cursor);
      const response = normalizeSearchResponse(data);
      pagesFetched += 1;

      if (response.tweets.length === 0) {
        break;
      }

      returnedTweets += response.tweets.length;

      for (const tweet of response.tweets) {
        if (seenTweetIds.has(tweet.id)) {
          duplicateTweets += 1;
          continue;
        }
        seenTweetIds.add(tweet.id);

        if (tweet.isReply) {
          replyTweets += 1;
          continue;
        }

        if (useServerTimeWindow || isWithinWindow(tweet, since, until)) {
          matchedTweets.push(tweet);
        } else {
          outsideWindowTweets += 1;
        }
      }

      const oldestTweet = response.tweets[response.tweets.length - 1];
      if (oldestTweet?.createdAt) {
        const oldestCreatedAtMs = new Date(oldestTweet.createdAt).getTime();
        const sinceMs = new Date(since).getTime();
        if (!Number.isNaN(oldestCreatedAtMs) && oldestCreatedAtMs < sinceMs) {
          break;
        }
      }

      if (!response.nextCursor) {
        break;
      }

      cursor = response.nextCursor;
    }

    logger.info("Advanced search summary", {
      username,
      query,
      since,
      until,
      useServerTimeWindow,
      maxPages,
      pagesFetched,
      returnedTweets,
      uniqueTweetsSeen: seenTweetIds.size,
      duplicateTweets,
      replyTweets,
      outsideWindowTweets,
      matchedTweets: matchedTweets.length,
      matchedQuoteTweets: matchedTweets.filter((tweet) => tweet.isQuoteTweet || tweet.quotedTweet).length
    });

    return matchedTweets;
  }

  async getTweetById(tweetId: string, authorUsername?: string): Promise<NormalizedTweet | null> {
    if (authorUsername) {
      let cursor: string | undefined;

      for (let page = 0; page < env.advancedSearchMaxPages; page += 1) {
        const data = await this.client.advancedSearch(`from:${authorUsername}`, cursor);
        const response = normalizeSearchResponse(data);
        const matchedTweet = response.tweets.find((tweet) => tweet.id === tweetId);
        if (matchedTweet) {
          return matchedTweet;
        }

        if (!response.nextCursor) {
          break;
        }
        cursor = response.nextCursor;
      }

      return null;
    }

    const data = await this.client.getTweetById(tweetId);
    if (data && typeof data === "object") {
      const record = data as Record<string, unknown>;
      return normalizeTweet(record.tweet ?? record.data ?? data);
    }
    return normalizeTweet(data);
  }
}

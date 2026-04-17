import { NormalizedTweet, TwitterSearchResponse, TwitterMetrics } from "../../types/twitter";

const toNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const metricsFromRaw = (raw: Record<string, unknown>): TwitterMetrics => {
  const legacyMetrics = (raw.public_metrics ?? raw.metrics ?? {}) as Record<string, unknown>;
  return {
    quoteCount: toNumber(raw.quoteCount ?? raw.quote_count ?? legacyMetrics.quote_count),
    likeCount: toNumber(raw.likeCount ?? raw.favorite_count ?? raw.like_count ?? legacyMetrics.like_count),
    replyCount: toNumber(raw.replyCount ?? raw.reply_count ?? legacyMetrics.reply_count),
    viewCount: toNumber(raw.viewCount ?? raw.view_count ?? raw.views ?? raw.impression_count ?? legacyMetrics.impression_count)
  };
};

const getAuthorUsername = (raw: Record<string, unknown>): string => {
  const author = (raw.author ?? raw.user ?? {}) as Record<string, unknown>;
  return String(author.userName ?? author.username ?? raw.author_username ?? raw.userName ?? "unknown");
};

const getAuthorFollowersCount = (raw: Record<string, unknown>): number | undefined => {
  const author = (raw.author ?? raw.user ?? {}) as Record<string, unknown>;
  const publicMetrics = (author.public_metrics ?? {}) as Record<string, unknown>;
  const candidate =
    author.followersCount ??
    author.followers_count ??
    publicMetrics.followers_count ??
    author.followers;

  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate;
  }
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const getTweetUrl = (raw: Record<string, unknown>, fallbackId: string, username: string): string => {
  const explicitUrl = raw.url ?? raw.tweet_url ?? raw.link;
  if (typeof explicitUrl === "string" && explicitUrl.length > 0) {
    return explicitUrl;
  }
  return `https://x.com/${username}/status/${fallbackId}`;
};

export const normalizeTweet = (raw: unknown): NormalizedTweet | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const input = raw as Record<string, unknown>;
  const id = String(input.id ?? input.tweet_id ?? input.rest_id ?? "");
  if (!id) {
    return null;
  }

  const authorUsername = getAuthorUsername(input);
  const text = String(input.text ?? input.full_text ?? "");

  const quoteCandidate =
    input.quoted_tweet ??
    input.quotedTweet ??
    input.quoted_status ??
    input.referenced_tweet ??
    null;

  const quotedTweet = quoteCandidate ? normalizeTweet(quoteCandidate) : null;
  const isQuoteTweet =
    Boolean(quotedTweet) ||
    input.is_quote_status === true ||
    input.isQuoteStatus === true ||
    input.tweetType === "quote";
  const isReply =
    input.isReply === true ||
    input.is_reply === true ||
    input.is_reply_status === true ||
    typeof input.inReplyToId === "string" ||
    typeof input.in_reply_to_status_id === "string" ||
    typeof input.inReplyToUsername === "string" ||
    typeof input.in_reply_to_screen_name === "string";

  return {
    id,
    text,
    url: getTweetUrl(input, id, authorUsername),
    author: {
      username: authorUsername,
      name: typeof (input.author as Record<string, unknown> | undefined)?.name === "string"
        ? String((input.author as Record<string, unknown>).name)
        : undefined,
      followersCount: getAuthorFollowersCount(input)
    },
    metrics: metricsFromRaw(input),
    isReply,
    isQuoteTweet,
    quotedTweet: quotedTweet ?? undefined,
    createdAt: typeof input.createdAt === "string" ? input.createdAt : typeof input.created_at === "string" ? input.created_at : undefined
  };
};

export const normalizeSearchResponse = (raw: unknown): TwitterSearchResponse => {
  if (!raw || typeof raw !== "object") {
    return { tweets: [] };
  }

  const payload = raw as Record<string, unknown>;
  const tweetsRaw =
    payload.tweets ??
    payload.data ??
    ((payload.results as Record<string, unknown> | undefined)?.tweets ?? null) ??
    [];

  const tweets = Array.isArray(tweetsRaw)
    ? tweetsRaw.map((tweet) => normalizeTweet(tweet)).filter((tweet): tweet is NormalizedTweet => Boolean(tweet))
    : [];

  return {
    tweets,
    nextCursor: typeof payload.next_cursor === "string" ? payload.next_cursor : null
  };
};

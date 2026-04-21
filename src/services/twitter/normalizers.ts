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

const isLikelyMediaUrl = (value: string): boolean => {
  const trimmedValue = value.trim();
  if (!/^https?:\/\//.test(trimmedValue)) {
    return false;
  }

  if (
    /twimg\.com\/(?:media|ext_tw_video_thumb|amplify_video_thumb)\//i.test(trimmedValue) ||
    /pbs\.twimg\.com\/media\//i.test(trimmedValue)
  ) {
    return true;
  }

  if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(trimmedValue)) {
    return true;
  }

  return /[?&]format=(jpg|jpeg|png|webp|gif)(?:&|$)/i.test(trimmedValue);
};

const MEDIA_CONTAINER_KEYS = new Set([
  "media",
  "mediaUrls",
  "media_urls",
  "photos",
  "photoUrls",
  "images",
  "imageUrls",
  "entities",
  "extended_entities",
  "card",
  "includes",
  "attachments",
  "cards",
  "variants",
  "video",
  "videos",
  "preview",
  "preview_image",
  "preview_image_url",
  "thumbnail",
  "thumbnail_url",
  "thumbnailUrl"
]);

const SHOULD_SKIP_KEYS = new Set([
  "author",
  "user",
  "profile",
  "profile_image",
  "profile_image_url",
  "profile_image_url_https",
  "avatar",
  "avatar_url",
  "banner",
  "banner_url"
]);

const collectMediaUrls = (raw: unknown, urls = new Set<string>()): Set<string> => {
  if (typeof raw === "string") {
    if (isLikelyMediaUrl(raw)) {
      urls.add(raw);
    }
    return urls;
  }

  if (!raw || typeof raw !== "object") {
    return urls;
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      collectMediaUrls(item, urls);
    }
    return urls;
  }

  const record = raw as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (SHOULD_SKIP_KEYS.has(key)) {
      continue;
    }

    if (typeof value === "string") {
      if (isLikelyMediaUrl(value)) {
        urls.add(value);
      }
      continue;
    }

    if (Array.isArray(value) || (value && typeof value === "object")) {
      if (MEDIA_CONTAINER_KEYS.has(key) || key === "media" || key === "entities" || key === "card" || key === "includes" || key === "attachments" || key === "extended_entities") {
        collectMediaUrls(value, urls);
      }
    }
  }

  return urls;
};

const getMediaUrls = (raw: Record<string, unknown>): string[] => {
  return [...collectMediaUrls(raw)];
};

const mergeTweetEnvelope = (input: Record<string, unknown>): Record<string, unknown> => {
  const nestedTweet = input.tweet;
  if (!nestedTweet || typeof nestedTweet !== "object" || Array.isArray(nestedTweet)) {
    return input;
  }

  const nestedRecord = nestedTweet as Record<string, unknown>;
  return {
    ...input,
    ...nestedRecord,
    author:
      input.author && typeof input.author === "object" && !Array.isArray(input.author)
        ? {
            ...(input.author as Record<string, unknown>),
            ...(nestedRecord.author && typeof nestedRecord.author === "object" && !Array.isArray(nestedRecord.author)
              ? (nestedRecord.author as Record<string, unknown>)
              : {})
          }
        : nestedRecord.author ?? input.author,
    user:
      input.user && typeof input.user === "object" && !Array.isArray(input.user)
        ? {
            ...(input.user as Record<string, unknown>),
            ...(nestedRecord.user && typeof nestedRecord.user === "object" && !Array.isArray(nestedRecord.user)
              ? (nestedRecord.user as Record<string, unknown>)
              : {})
          }
        : nestedRecord.user ?? input.user,
    media:
      Array.isArray(input.media) && Array.isArray(nestedRecord.media)
        ? [...input.media, ...nestedRecord.media]
        : nestedRecord.media ?? input.media,
    photos:
      Array.isArray(input.photos) && Array.isArray(nestedRecord.photos)
        ? [...input.photos, ...nestedRecord.photos]
        : nestedRecord.photos ?? input.photos,
    images:
      Array.isArray(input.images) && Array.isArray(nestedRecord.images)
        ? [...input.images, ...nestedRecord.images]
        : nestedRecord.images ?? input.images
  };
};

const hasQuotedReference = (raw: Record<string, unknown>): boolean => {
  const references = raw.referenced_tweets ?? raw.referencedTweets;
  if (!Array.isArray(references)) {
    return false;
  }

  return references.some((reference) => {
    if (!reference || typeof reference !== "object") {
      return false;
    }

    const record = reference as Record<string, unknown>;
    return record.type === "quoted" || record.type === "quote" || record.referenced_tweet_type === "quoted";
  });
};

export const normalizeTweet = (raw: unknown): NormalizedTweet | null => {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const input = mergeTweetEnvelope(raw as Record<string, unknown>);
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
    input.tweetType === "quote" ||
    typeof input.quoted_tweet_id === "string" ||
    typeof input.quoted_status_id === "string" ||
    hasQuotedReference(input);
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
    mediaUrls: getMediaUrls(input),
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

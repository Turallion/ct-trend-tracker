export interface TwitterMetrics {
  quoteCount: number;
  likeCount: number;
  replyCount: number;
  viewCount: number;
}

export interface TweetAuthor {
  username: string;
  name?: string;
  followersCount?: number;
}

export interface NormalizedTweet {
  id: string;
  text: string;
  url: string;
  author: TweetAuthor;
  metrics: TwitterMetrics;
  mediaUrls: string[];
  isReply: boolean;
  isQuoteTweet: boolean;
  quotedTweet?: NormalizedTweet;
  createdAt?: string;
}

export interface TwitterSearchResponse {
  tweets: NormalizedTweet[];
  nextCursor?: string | null;
}

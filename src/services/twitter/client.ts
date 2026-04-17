import axios, { AxiosInstance } from "axios";
import { env, requireTwitterConfig } from "../../config/env";
import { withRetry } from "../../utils/retry";
import { CircuitBreaker } from "../../utils/circuitBreaker";

export class TwitterApiClient {
  private readonly http: AxiosInstance;
  readonly breaker: CircuitBreaker;

  constructor() {
    const { twitterApiKey } = requireTwitterConfig();

    this.http = axios.create({
      baseURL: "https://api.twitterapi.io",
      timeout: env.httpTimeoutMs,
      headers: {
        "X-API-Key": twitterApiKey,
        "Content-Type": "application/json"
      }
    });

    this.breaker = new CircuitBreaker(
      "twitterapi.io",
      env.circuitFailureThreshold,
      env.circuitCooldownMs
    );
  }

  async advancedSearch(query: string, cursor?: string): Promise<unknown> {
    return this.breaker.execute(() =>
      withRetry("twitterapi.io advanced search", env.httpRetryAttempts, async () => {
        const response = await this.http.get("/twitter/tweet/advanced_search", {
          params: cursor ? { query, cursor } : { query }
        });
        return response.data;
      })
    );
  }

  async advancedSearchWithTimeWindow(
    username: string,
    since: string,
    until: string,
    cursor?: string
  ): Promise<unknown> {
    return this.breaker.execute(() =>
      withRetry("twitterapi.io advanced search with time window", env.httpRetryAttempts, async () => {
        const sinceTime = Math.floor(new Date(since).getTime() / 1000);
        const untilTime = Math.floor(new Date(until).getTime() / 1000);
        const query = `from:${username} -filter:replies since_time:${sinceTime} until_time:${untilTime}`;
        const response = await this.http.get("/twitter/tweet/advanced_search", {
          params: cursor ? { query, cursor } : { query }
        });
        return response.data;
      })
    );
  }

  async getTweetById(tweetId: string): Promise<unknown> {
    return this.breaker.execute(() =>
      withRetry("twitterapi.io get tweet", env.httpRetryAttempts, async () => {
        const response = await this.http.get("/twitter/tweet", {
          params: { tweet_id: tweetId }
        });
        return response.data;
      })
    );
  }
}

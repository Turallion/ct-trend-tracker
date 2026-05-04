import { getDb } from "./database";
import { DailyAlertSummaryItem, PendingAlertRecord, StoredOriginalTweet, TrackedAccountQuote } from "../types/trends";
import { TwitterMetrics } from "../types/twitter";

export interface TrackedAccountRecord {
  id: number;
  username: string;
  isActive: boolean;
  priority: number;
  createdAt: string;
}

const db = getDb();

export const trackedAccountRepository = {
  insertMany: (accounts: Array<{ username: string; priority: number }>): void => {
    const statement = db.prepare(`
      INSERT INTO tracked_accounts (username, priority, is_active)
      VALUES (@username, @priority, 1)
      ON CONFLICT(username) DO UPDATE SET
        priority = excluded.priority,
        is_active = 1
    `);

    const transaction = db.transaction((rows: Array<{ username: string; priority: number }>) => {
      for (const row of rows) {
        statement.run(row);
      }
    });

    transaction(accounts);
  },
  replaceAllActive: (accounts: Array<{ username: string; priority: number }>): void => {
    const upsertStatement = db.prepare(`
      INSERT INTO tracked_accounts (username, priority, is_active)
      VALUES (@username, @priority, 1)
      ON CONFLICT(username) DO UPDATE SET
        priority = excluded.priority,
        is_active = 1
    `);
    const deactivateAllStatement = db.prepare(`
      UPDATE tracked_accounts
      SET is_active = 0
    `);

    const transaction = db.transaction((rows: Array<{ username: string; priority: number }>) => {
      deactivateAllStatement.run();
      for (const row of rows) {
        upsertStatement.run(row);
      }
    });

    transaction(accounts);
  },
  listActive: (): TrackedAccountRecord[] => {
    return db
      .prepare(`
        SELECT
          id,
          username,
          is_active AS isActive,
          priority,
          created_at AS createdAt
        FROM tracked_accounts
        WHERE is_active = 1
        ORDER BY priority ASC, username ASC
      `)
      .all() as TrackedAccountRecord[];
  }
};

export const quoteRepository = {
  isQuoteTweetKnown: (quoteTweetId: string): boolean => {
    const row = db
      .prepare(`SELECT 1 FROM detected_quote_tweets WHERE quote_tweet_id = ? LIMIT 1`)
      .get(quoteTweetId);
    return Boolean(row);
  },
  insertDetectedQuote: (input: {
    trackedAccountUsername: string;
    quoteTweetId: string;
    originalTweetId: string;
    detectedAt: string;
    originalAuthorUsername: string;
    originalText: string;
    originalUrl: string;
    quoteChain?: string[];
  }): void => {
    db.prepare(`
      INSERT OR IGNORE INTO detected_quote_tweets (
        tracked_account_username,
        quote_tweet_id,
        original_tweet_id,
        detected_at,
        original_author_username,
        original_text,
        original_url,
        quote_chain
      ) VALUES (
        @trackedAccountUsername,
        @quoteTweetId,
        @originalTweetId,
        @detectedAt,
        @originalAuthorUsername,
        @originalText,
        @originalUrl,
        @quoteChain
      )
    `).run({
      trackedAccountUsername: input.trackedAccountUsername,
      quoteTweetId: input.quoteTweetId,
      originalTweetId: input.originalTweetId,
      detectedAt: input.detectedAt,
      originalAuthorUsername: input.originalAuthorUsername,
      originalText: input.originalText,
      originalUrl: input.originalUrl,
      quoteChain: input.quoteChain && input.quoteChain.length > 0 ? JSON.stringify(input.quoteChain) : null
    });
  },
  linkTrackedAccountToOriginal: (input: {
    originalTweetId: string;
    trackedAccountUsername: string;
    quoteTweetId: string;
    quoteTweetUrl: string;
    detectedAt: string;
  }): void => {
    db.prepare(`
      INSERT OR IGNORE INTO original_tweet_tracked_accounts (
        original_tweet_id,
        tracked_account_username,
        quote_tweet_id,
        quote_tweet_url,
        detected_at
      ) VALUES (
        @originalTweetId,
        @trackedAccountUsername,
        @quoteTweetId,
        @quoteTweetUrl,
        @detectedAt
      )
    `).run(input);
  },
  listTrackedQuotesForOriginal: (originalTweetId: string): TrackedAccountQuote[] => {
    return db
      .prepare(`
        SELECT
          tracked_account_username AS trackedAccountUsername,
          quote_tweet_id AS quoteTweetId,
          quote_tweet_url AS quoteTweetUrl,
          detected_at AS detectedAt
        FROM original_tweet_tracked_accounts
        WHERE original_tweet_id = ?
        ORDER BY detected_at ASC
      `)
      .all(originalTweetId) as TrackedAccountQuote[];
  }
};

export const originalTweetRepository = {
  upsertOriginalTweet: (input: {
    originalTweetId: string;
    originalAuthorUsername: string;
    originalText: string;
    originalUrl: string;
    firstSeenAt: string;
    firstDetectedAt: string;
    originalCreatedAt?: string;
    isTooOld: boolean;
    ignoredReason?: string | null;
    metrics: TwitterMetrics;
    originalAuthorFollowersCount?: number | null;
  }): StoredOriginalTweet => {
    db.prepare(`
      INSERT INTO original_tweets (
        original_tweet_id,
        original_author_username,
        original_text,
        original_url,
        first_seen_at,
        first_detected_at,
        original_created_at,
        is_too_old,
        ignored_reason,
        current_quote_count,
        current_like_count,
        current_reply_count,
        current_view_count,
        original_author_followers_count,
        last_reported_quote_count,
        last_reported_at
      ) VALUES (
        @originalTweetId,
        @originalAuthorUsername,
        @originalText,
        @originalUrl,
        @firstSeenAt,
        @firstDetectedAt,
        @originalCreatedAt,
        @isTooOld,
        @ignoredReason,
        @currentQuoteCount,
        @currentLikeCount,
        @currentReplyCount,
        @currentViewCount,
        @originalAuthorFollowersCount,
        NULL,
        NULL
      )
      ON CONFLICT(original_tweet_id) DO UPDATE SET
        original_author_username = excluded.original_author_username,
        original_text = excluded.original_text,
        original_url = excluded.original_url,
        original_created_at = COALESCE(original_tweets.original_created_at, excluded.original_created_at),
        ignored_reason = COALESCE(excluded.ignored_reason, original_tweets.ignored_reason),
        is_too_old = CASE
          WHEN original_tweets.is_too_old = 1 OR excluded.is_too_old = 1 THEN 1
          ELSE 0
        END,
        current_quote_count = excluded.current_quote_count,
        current_like_count = excluded.current_like_count,
        current_reply_count = excluded.current_reply_count,
        current_view_count = excluded.current_view_count,
        original_author_followers_count = COALESCE(excluded.original_author_followers_count, original_tweets.original_author_followers_count)
    `).run({
      originalTweetId: input.originalTweetId,
      originalAuthorUsername: input.originalAuthorUsername,
      originalText: input.originalText,
      originalUrl: input.originalUrl,
      firstSeenAt: input.firstSeenAt,
      firstDetectedAt: input.firstDetectedAt,
      originalCreatedAt: input.originalCreatedAt ?? null,
      isTooOld: input.isTooOld ? 1 : 0,
      ignoredReason: input.ignoredReason ?? null,
      currentQuoteCount: input.metrics.quoteCount,
      currentLikeCount: input.metrics.likeCount,
      currentReplyCount: input.metrics.replyCount,
      currentViewCount: input.metrics.viewCount,
      originalAuthorFollowersCount: input.originalAuthorFollowersCount ?? null
    });

    return originalTweetRepository.getByTweetId(input.originalTweetId)!;
  },
  getByTweetId: (originalTweetId: string): StoredOriginalTweet | null => {
    const row = db
      .prepare(`
        SELECT
          original_tweet_id AS originalTweetId,
          original_author_username AS originalAuthorUsername,
          original_text AS originalText,
          original_url AS originalUrl,
          first_seen_at AS firstSeenAt,
          first_detected_at AS firstDetectedAt,
          original_created_at AS originalCreatedAt,
          is_too_old AS isTooOld,
          ignored_reason AS ignoredReason,
          current_quote_count AS currentQuoteCount,
          current_like_count AS currentLikeCount,
          current_reply_count AS currentReplyCount,
          current_view_count AS currentViewCount,
          original_author_followers_count AS originalAuthorFollowersCount,
          alert_sent AS alertSent,
          alert_sent_at AS alertSentAt,
          last_signal_sent AS lastSignalSent,
          last_reported_quote_count AS lastReportedQuoteCount,
          last_reported_at AS lastReportedAt,
          signal_a_triggered AS signalATriggered,
          signal_b_triggered AS signalBTriggered,
          signal_c_triggered AS signalCTriggered
        FROM original_tweets
        WHERE original_tweet_id = ?
        LIMIT 1
      `)
      .get(originalTweetId) as StoredOriginalTweet | undefined;

    return row ?? null;
  },
  updateSignalFlags: (originalTweetId: string, signals: Array<"A" | "B" | "C">): void => {
    const current = originalTweetRepository.getByTweetId(originalTweetId);
    if (!current) {
      return;
    }

    db.prepare(`
      UPDATE original_tweets
      SET
        alert_sent = 1,
        alert_sent_at = COALESCE(alert_sent_at, ?),
        last_signal_sent = ?,
        signal_a_triggered = ?,
        signal_b_triggered = ?,
        signal_c_triggered = ?
      WHERE original_tweet_id = ?
    `).run(
      new Date().toISOString(),
      signals.join(","),
      current.signalATriggered || signals.includes("A") ? 1 : 0,
      current.signalBTriggered || signals.includes("B") ? 1 : 0,
      current.signalCTriggered || signals.includes("C") ? 1 : 0,
      originalTweetId
    );
  },
  updateSignalFlagsWithoutAlert: (originalTweetId: string, signals: Array<"A" | "B" | "C">): void => {
    const current = originalTweetRepository.getByTweetId(originalTweetId);
    if (!current || signals.length === 0) {
      return;
    }

    db.prepare(`
      UPDATE original_tweets
      SET
        signal_a_triggered = ?,
        signal_b_triggered = ?,
        signal_c_triggered = ?
      WHERE original_tweet_id = ?
    `).run(
      current.signalATriggered || signals.includes("A") ? 1 : 0,
      current.signalBTriggered || signals.includes("B") ? 1 : 0,
      current.signalCTriggered || signals.includes("C") ? 1 : 0,
      originalTweetId
    );
  },
  hasAlreadyBeenAlerted: (originalTweetId: string): boolean => {
    const row = db
      .prepare(`
        SELECT 1
        FROM original_tweets
        WHERE original_tweet_id = ?
          AND (alert_sent = 1 OR alert_sent_at IS NOT NULL)
        LIMIT 1
      `)
      .get(originalTweetId);

    return Boolean(row);
  },
  getTriggeredSignals: (originalTweetId: string): Array<"A" | "B" | "C"> => {
    const row = db
      .prepare(`
        SELECT
          signal_a_triggered AS signalATriggered,
          signal_b_triggered AS signalBTriggered,
          signal_c_triggered AS signalCTriggered
        FROM original_tweets
        WHERE original_tweet_id = ?
        LIMIT 1
      `)
      .get(originalTweetId) as
      | { signalATriggered: number; signalBTriggered: number; signalCTriggered: number }
      | undefined;

    if (!row) {
      return [];
    }

    const signals: Array<"A" | "B" | "C"> = [];
    if (row.signalATriggered) signals.push("A");
    if (row.signalBTriggered) signals.push("B");
    if (row.signalCTriggered) signals.push("C");
    return signals;
  },
  updateCurrentMetrics: (originalTweetId: string, metrics: TwitterMetrics): void => {
    db.prepare(`
      UPDATE original_tweets
      SET
        current_quote_count = ?,
        current_like_count = ?,
        current_reply_count = ?,
        current_view_count = ?
      WHERE original_tweet_id = ?
    `).run(
      metrics.quoteCount,
      metrics.likeCount,
      metrics.replyCount,
      metrics.viewCount,
      originalTweetId
    );
  },
  shouldEmitMakerTweetReport: (originalTweetId: string, quoteCount: number, at: string): boolean => {
    const current = originalTweetRepository.getByTweetId(originalTweetId);
    if (!current) {
      return true;
    }

    const lastReportedQuoteCount = current.lastReportedQuoteCount;
    if (typeof lastReportedQuoteCount === "number" && quoteCount <= lastReportedQuoteCount) {
      return false;
    }

    db.prepare(`
      UPDATE original_tweets
      SET
        last_reported_quote_count = ?,
        last_reported_at = ?
      WHERE original_tweet_id = ?
    `).run(quoteCount, at, originalTweetId);

    return true;
  },
  listTweetsNeedingGrowthChecks: (hoursBack = 4): StoredOriginalTweet[] => {
    return db
      .prepare(`
        SELECT
          original_tweet_id AS originalTweetId,
          original_author_username AS originalAuthorUsername,
          original_text AS originalText,
          original_url AS originalUrl,
          first_seen_at AS firstSeenAt,
          first_detected_at AS firstDetectedAt,
          original_created_at AS originalCreatedAt,
          is_too_old AS isTooOld,
          ignored_reason AS ignoredReason,
          current_quote_count AS currentQuoteCount,
          current_like_count AS currentLikeCount,
          current_reply_count AS currentReplyCount,
          current_view_count AS currentViewCount,
          original_author_followers_count AS originalAuthorFollowersCount,
          alert_sent AS alertSent,
          alert_sent_at AS alertSentAt,
          last_signal_sent AS lastSignalSent,
          last_reported_quote_count AS lastReportedQuoteCount,
          last_reported_at AS lastReportedAt,
          signal_a_triggered AS signalATriggered,
          signal_b_triggered AS signalBTriggered,
          signal_c_triggered AS signalCTriggered
        FROM original_tweets
        WHERE datetime(first_detected_at) >= datetime('now', ?)
          AND is_too_old = 0
          AND ignored_reason IS NULL
          AND alert_sent = 0
      `)
      .all(`-${hoursBack} hours`) as StoredOriginalTweet[];
  },
  saveSnapshot: (originalTweetId: string, checkedAt: string, metrics: TwitterMetrics): void => {
    db.prepare(`
      INSERT INTO original_tweet_snapshots (
        original_tweet_id,
        checked_at,
        quote_count,
        like_count,
        reply_count,
        view_count
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      originalTweetId,
      checkedAt,
      metrics.quoteCount,
      metrics.likeCount,
      metrics.replyCount,
      metrics.viewCount
    );

    originalTweetRepository.updateCurrentMetrics(originalTweetId, metrics);
  },
  getOldestSnapshotWithinWindow: (originalTweetId: string, hoursBack = 4): { quoteCount: number } | null => {
    const row = db
      .prepare(`
        SELECT quote_count AS quoteCount
        FROM original_tweet_snapshots
        WHERE original_tweet_id = ?
          AND datetime(checked_at) >= datetime('now', ?)
        ORDER BY datetime(checked_at) ASC
        LIMIT 1
      `)
      .get(originalTweetId, `-${hoursBack} hours`) as { quoteCount: number } | undefined;

    return row ?? null;
  },
  markHistorical: (originalTweetId: string, at: string): void => {
    db.prepare(`
      UPDATE original_tweets
      SET
        alert_sent = 1,
        alert_sent_at = COALESCE(alert_sent_at, ?),
        last_signal_sent = COALESCE(last_signal_sent, 'HISTORICAL'),
        signal_a_triggered = 1,
        signal_b_triggered = 1,
        signal_c_triggered = 1
      WHERE original_tweet_id = ?
    `).run(at, originalTweetId);
  },
  markIgnored: (originalTweetId: string, reason: string): void => {
    db.prepare(`
      UPDATE original_tweets
      SET ignored_reason = COALESCE(ignored_reason, ?)
      WHERE original_tweet_id = ?
    `).run(reason, originalTweetId);
  },
  listOldAlerted: (retentionDays: number): Array<{ originalTweetId: string }> => {
    return db
      .prepare(`
        SELECT original_tweet_id AS originalTweetId
        FROM original_tweets
        WHERE alert_sent = 1
          AND datetime(first_detected_at) < datetime('now', ?)
      `)
      .all(`-${retentionDays} days`) as Array<{ originalTweetId: string }>;
  },
  listAlertedBetween: (since: string, until: string): DailyAlertSummaryItem[] => {
    return db
      .prepare(`
        SELECT
          original_tweet_id AS originalTweetId,
          original_author_username AS originalAuthorUsername,
          original_url AS originalUrl,
          current_quote_count AS currentQuoteCount,
          alert_sent_at AS alertSentAt
        FROM original_tweets
        WHERE alert_sent = 1
          AND alert_sent_at IS NOT NULL
          AND datetime(alert_sent_at) >= datetime(?)
          AND datetime(alert_sent_at) < datetime(?)
        ORDER BY current_quote_count DESC, datetime(alert_sent_at) ASC
      `)
      .all(since, until) as DailyAlertSummaryItem[];
  },
  deleteByTweetIds: (ids: string[]): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(`DELETE FROM original_tweets WHERE original_tweet_id IN (${placeholders})`)
      .run(...ids);
    return Number(result.changes);
  },
  purgeOldSnapshots: (retentionDays: number): number => {
    const result = db
      .prepare(`
        DELETE FROM original_tweet_snapshots
        WHERE datetime(checked_at) < datetime('now', ?)
          AND id NOT IN (
            SELECT MIN(id) FROM original_tweet_snapshots GROUP BY original_tweet_id
            UNION
            SELECT MAX(id) FROM original_tweet_snapshots GROUP BY original_tweet_id
          )
      `)
      .run(`-${retentionDays} days`);
    return Number(result.changes);
  },
  deleteSnapshotsByTweetIds: (ids: string[]): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(`DELETE FROM original_tweet_snapshots WHERE original_tweet_id IN (${placeholders})`)
      .run(...ids);
    return Number(result.changes);
  },
  deleteDetectedQuotesByTweetIds: (ids: string[]): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(`DELETE FROM detected_quote_tweets WHERE original_tweet_id IN (${placeholders})`)
      .run(...ids);
    return Number(result.changes);
  },
  deleteTrackedAccountLinksByTweetIds: (ids: string[]): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(`DELETE FROM original_tweet_tracked_accounts WHERE original_tweet_id IN (${placeholders})`)
      .run(...ids);
    return Number(result.changes);
  },
  runCascadeDelete: (ids: string[]): void => {
    const transaction = db.transaction((tweetIds: string[]) => {
      originalTweetRepository.deleteSnapshotsByTweetIds(tweetIds);
      originalTweetRepository.deleteDetectedQuotesByTweetIds(tweetIds);
      originalTweetRepository.deleteTrackedAccountLinksByTweetIds(tweetIds);
      pendingAlertRepository.deleteByTweetIds(tweetIds);
      originalTweetRepository.deleteByTweetIds(tweetIds);
    });
    transaction(ids);
  }
};

export const pendingAlertRepository = {
  enqueue: (input: { originalTweetId: string; payloadJson: string; signals: string; createdAt: string }): number => {
    const result = db
      .prepare(`
        INSERT INTO pending_alerts (
          original_tweet_id, payload_json, signals, created_at, attempts, status
        ) VALUES (?, ?, ?, ?, 0, 'pending')
      `)
      .run(input.originalTweetId, input.payloadJson, input.signals, input.createdAt);
    return Number(result.lastInsertRowid);
  },
  listReadyToSend: (now: string): PendingAlertRecord[] => {
    return db
      .prepare(`
        SELECT
          id,
          original_tweet_id AS originalTweetId,
          payload_json AS payloadJson,
          signals,
          created_at AS createdAt,
          attempts,
          last_attempt_at AS lastAttemptAt,
          last_error AS lastError,
          status
        FROM pending_alerts
        WHERE status = 'pending'
        ORDER BY datetime(created_at) ASC
      `)
      .all() as PendingAlertRecord[];
  },
  markSent: (id: number, at: string): void => {
    db.prepare(`
      UPDATE pending_alerts
      SET status = 'sent', last_attempt_at = ?
      WHERE id = ?
    `).run(at, id);
  },
  markAttemptFailed: (id: number, at: string, error: string, newAttempts: number, failed: boolean): void => {
    db.prepare(`
      UPDATE pending_alerts
      SET attempts = ?,
          last_attempt_at = ?,
          last_error = ?,
          status = ?
      WHERE id = ?
    `).run(newAttempts, at, error, failed ? "failed" : "pending", id);
  },
  deleteByTweetIds: (ids: string[]): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(",");
    const result = db
      .prepare(`
        DELETE FROM pending_alerts
        WHERE original_tweet_id IN (${placeholders})
          AND status IN ('sent', 'failed')
      `)
      .run(...ids);
    return Number(result.changes);
  }
};

export const appStateRepository = {
  get: (key: string): string | null => {
    const row = db
      .prepare(`SELECT value FROM app_state WHERE key = ? LIMIT 1`)
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? null;
  },
  set: (key: string, value: string): void => {
    db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString());
  }
};

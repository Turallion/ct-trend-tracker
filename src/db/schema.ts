export const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS tracked_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS detected_quote_tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracked_account_username TEXT NOT NULL,
      quote_tweet_id TEXT NOT NULL UNIQUE,
      original_tweet_id TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      original_author_username TEXT NOT NULL,
      original_text TEXT NOT NULL,
      original_url TEXT NOT NULL,
      quote_chain TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS original_tweets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_tweet_id TEXT NOT NULL UNIQUE,
      original_author_username TEXT NOT NULL,
      original_text TEXT NOT NULL,
      original_url TEXT NOT NULL,
      first_seen_at TEXT,
      first_detected_at TEXT NOT NULL,
      original_created_at TEXT,
      is_too_old INTEGER NOT NULL DEFAULT 0,
      ignored_reason TEXT,
      current_quote_count INTEGER NOT NULL DEFAULT 0,
      current_like_count INTEGER NOT NULL DEFAULT 0,
      current_reply_count INTEGER NOT NULL DEFAULT 0,
      current_view_count INTEGER NOT NULL DEFAULT 0,
      original_author_followers_count INTEGER,
      alert_sent INTEGER NOT NULL DEFAULT 0,
      alert_sent_at TEXT,
      last_signal_sent TEXT,
      signal_a_triggered INTEGER NOT NULL DEFAULT 0,
      signal_b_triggered INTEGER NOT NULL DEFAULT 0,
      signal_c_triggered INTEGER NOT NULL DEFAULT 0
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS original_tweet_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_tweet_id TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      quote_count INTEGER NOT NULL DEFAULT 0,
      like_count INTEGER NOT NULL DEFAULT 0,
      reply_count INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS original_tweet_tracked_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_tweet_id TEXT NOT NULL,
      tracked_account_username TEXT NOT NULL,
      quote_tweet_id TEXT NOT NULL,
      quote_tweet_url TEXT NOT NULL,
      detected_at TEXT NOT NULL,
      UNIQUE (original_tweet_id, tracked_account_username, quote_tweet_id)
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS pending_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_tweet_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      signals TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    )
  `,
  `CREATE INDEX IF NOT EXISTS idx_detected_quote_tweets_original_tweet_id ON detected_quote_tweets(original_tweet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_original_tweet_snapshots_original_tweet_id ON original_tweet_snapshots(original_tweet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_original_tweet_tracked_accounts_original_tweet_id ON original_tweet_tracked_accounts(original_tweet_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_alerts_status ON pending_alerts(status, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_pending_alerts_original_tweet_id ON pending_alerts(original_tweet_id)`
];

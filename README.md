# CT Trend Hunter

CT Trend Hunter is a production-oriented Node.js + TypeScript MVP that monitors a curated list of Crypto Twitter/X accounts, detects quote-tweeted trend candidates, evaluates momentum signals, and sends Telegram alerts.

## What it does

- Monitors tracked accounts by querying `twitterapi.io` Advanced Search in rolling time windows.
- Detects quote tweets and treats the original quoted tweet as the trend candidate.
- Evaluates three independent signals:
  - `A`: quote growth over repeated checks in the last 1-4 hours
  - `B`: cluster detection when multiple tracked accounts quote the same original tweet
  - `C`: already-hot detection when the original tweet already has strong quote volume
- Sends combined Telegram alerts without re-alerting the same signal twice for the same original tweet.
- Runs only during configured Moscow work hours.
- Supports dry-run mode for safe validation without hitting Telegram.

## Tech stack

- Node.js 20+
- TypeScript
- SQLite via `better-sqlite3`
- Axios for HTTP
- dotenv for configuration

## Project structure

```text
src/
  config/
  db/
  jobs/
  services/
    telegram/
    trends/
    twitter/
  types/
  utils/
  index.ts
tracked_accounts.json
```

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Fill in the required values in `.env`:

- `TWITTERAPI_IO_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

4. Seed the curated accounts:

```bash
npm run seed
```

5. Start in development mode:

```bash
npm run dev
```

6. Build and run in production:

```bash
npm run build
npm start
```

## Configuration

All trend thresholds and runtime controls are configurable through environment variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `TIMEZONE` | Scheduler timezone | `Europe/Moscow` |
| `WORK_START_HOUR` | Work window start hour | `8` |
| `WORK_END_HOUR` | Work window end hour | `19` |
| `POLL_MINUTES` | Poll interval in minutes | `30` |
| `MORNING_CATCHUP_SINCE_HOUR` | On the first run of the day, fetch tweets starting from this Moscow hour | `7` |
| `ADVANCED_SEARCH_MAX_PAGES` | Max advanced search pages to scan per account before stopping | `1` |
| `USE_SERVER_TIME_WINDOW` | Use `since_time` / `until_time` inside Advanced Search queries | `true` |
| `TREND_MAKERS_FILE` | Source file for accounts whose own tweets can trigger trends | `./trend_makers.json` |
| `OWN_TWEET_LOOKBACK_HOURS` | Lookback window for trend-maker own tweets | `4` |
| `POLL_CONCURRENCY` | Number of tracked accounts processed in parallel per cycle | `3` |
| `SIGNAL_C_MIN_QUOTES` | Already-hot minimum quote count | `10` |
| `SIGNAL_C_TIER_SMALL_MAX` | Upper follower bound for small original authors | `20000` |
| `SIGNAL_C_TIER_MEDIUM_MAX` | Upper follower bound for medium original authors | `50000` |
| `SIGNAL_C_QUOTES_SMALL` | Signal C quote threshold below `20000` followers | `5` |
| `SIGNAL_C_QUOTES_MEDIUM` | Signal C quote threshold from `20000` to `50000` followers | `10` |
| `SIGNAL_C_QUOTES_LARGE` | Signal C quote threshold above `50000` followers | `15` |
| `SIGNAL_B_MIN_TRACKED_QUOTES` | Distinct tracked accounts needed for cluster | `2` |
| `SIGNAL_A_MIN_QUOTE_GROWTH` | Quote growth threshold across snapshots | `3` |
| `ENABLE_SIGNAL_A` | Enables the expensive growth-refresh flow for Signal A | `false` |
| `ORIGINAL_TWEET_MAX_AGE_HOURS` | Ignore original tweets older than this age | `48` |
| `ENABLE_QUALITY_FILTERS` | Ignore giveaway/project-update original tweets before alerting | `true` |
| `QUALITY_FILTERS_FILE` | Regex patterns for giveaway and project-update text filters | `./quality_filters.json` |
| `PROJECT_ACCOUNTS_FILE` | Manual blocklist of official/project accounts to ignore as originals | `./project_accounts.json` |
| `SKIP_ALERTS_ON_FIRST_RUN` | Bootstrap mode that suppresses alerts on the first polling cycle | `true` |
| `SEND_POLL_REPORTS` | Send a Telegram check report after every polling run | `false` |
| `TELEGRAM_ALERT_CHAT_ID` | Telegram destination for detected trend alerts | required |
| `TELEGRAM_LOG_CHAT_ID` | Telegram destination for run reports and no-trend messages | required |
| `DATABASE_PATH` | SQLite file path | `./data/ct-trend-hunter.sqlite` |
| `TRACKED_ACCOUNTS_FILE` | Seed source file | `./tracked_accounts.json` |
| `DRY_RUN` | Log alerts instead of sending Telegram messages | `true` |
| `HTTP_TIMEOUT_MS` | Outbound HTTP timeout | `20000` |
| `HTTP_RETRY_ATTEMPTS` | Retry attempts for API calls | `3` |

## Data model

The app creates and uses these SQLite tables:

- `tracked_accounts`
- `detected_quote_tweets`
- `original_tweets`
- `original_tweet_snapshots`
- `original_tweet_tracked_accounts`

The `original_tweets` table also tracks:

- `first_seen_at`
- `original_created_at`
- `is_too_old`
- `ignored_reason`
- `alert_sent_at`
- `last_signal_sent`

## Notes on twitterapi.io response handling

`twitterapi.io` response payloads can vary between endpoints and plan tiers, especially around:

- metrics field naming
- author nesting
- quoted tweet nesting
- direct URL fields

The normalizers in [`src/services/twitter/normalizers.ts`](/Users/turaljalilov/Documents/Trend tracker/src/services/twitter/normalizers.ts) intentionally handle multiple possible shapes and fall back conservatively when fields are missing.

## Operational behavior

- The scheduler wakes up every 15 seconds and only executes once per valid 30-minute slot.
- The first polling cycle of the day uses an extended catch-up window from `06:00` Moscow time to the current slot, and that state is persisted in SQLite so a daytime restart does not re-run the whole morning catch-up.
- On the first polling cycle after startup, the app can store quote-tweet discoveries as baseline data without sending alerts when `SKIP_ALERTS_ON_FIRST_RUN=true`.
- The app skips all work outside the configured Moscow window.
- The polling query uses:

```text
from:USERNAME
```

- The app paginates advanced search results and filters the returned tweets locally by the target time window. This is more reliable for very active accounts whose relevant tweet may fall outside the first page or when time-filtered search is incomplete.
- In the cheap production setup, `ADVANCED_SEARCH_MAX_PAGES=1`, so the app only checks the first page per account to keep costs low.
- Replies are excluded both at query level and by API reply metadata, so quote tweets that begin with `@` are less likely to be misclassified.
- Signal `A` uses snapshots recorded over time and compares the latest quote count to the oldest snapshot in the last 4 hours.
- Signal `B` counts distinct tracked accounts linked to the same original tweet.
- Signal `C` is evaluated immediately on first detection using follower-aware thresholds:
- below `20000` followers -> `5` quotes
- from `20000` to `50000` followers -> `10` quotes
- above `50000` followers -> `15` quotes
- Original tweets older than `ORIGINAL_TWEET_MAX_AGE_HOURS` are marked stale and ignored for alerting.
- Giveaway/project-update originals can be ignored before trend scoring when `ENABLE_QUALITY_FILTERS=true`.
- The app avoids duplicate alerts for the same signal on the same original tweet, but it can still send a later alert if a new signal appears for that tweet.

## Cheap Mode

The cheapest practical production mode for this project is:

- `ADVANCED_SEARCH_MAX_PAGES=1`
- `ENABLE_SIGNAL_A=false`
- polling only for current account windows
- no expensive refresh phase for historical original tweets

In this mode the app focuses on:

- `B`: multiple tracked accounts quote the same original tweet
- `C`: the original tweet is already hot when first detected

This keeps credit usage much lower than the earlier MVP logic while still catching the most useful trend cases.

## First-run protection

With `SKIP_ALERTS_ON_FIRST_RUN=true`, the first scheduler cycle after process startup works as a warm-up pass:

- quote tweets are still discovered and stored
- original tweets and snapshots are still persisted
- no Telegram alerts are sent during that first cycle

This avoids historical backlog noise when the service starts mid-session. From the second polling cycle onward, normal alerting resumes.

## Stale trend filtering

When a tracked account quote-tweets an original tweet, CT Trend Hunter compares the original tweet creation time to the current check time.

- If the original tweet is older than `ORIGINAL_TWEET_MAX_AGE_HOURS`, it is marked as stale with `is_too_old=1`
- stale originals are saved for baseline/reference purposes
- stale originals do not trigger Telegram alerts

## Quality Filters

Set `ENABLE_QUALITY_FILTERS=true` to ignore low-signal original tweets before trend scoring.

The giveaway filter uses regex patterns from [`quality_filters.json`](/Users/turaljalilov/Documents/Trend tracker/quality_filters.json), such as follow/RT, giveaway, raffle, survey, tag friends, and entries-win mechanics. The project filter uses [`project_accounts.json`](/Users/turaljalilov/Documents/Trend tracker/project_accounts.json) as a manual list of official/project accounts whose original tweets should not alert, plus conservative project-update text patterns.

Ignored originals are still stored in SQLite with an `ignored_reason` so they do not keep reappearing as fresh candidates.

## Dry run mode

Set `DRY_RUN=true` to validate the full pipeline without sending Telegram messages. Alerts will be logged as structured JSON instead.

## Poll Reports

Set `SEND_POLL_REPORTS=true` when you want a Telegram message after every scheduled check.

Each run sends a first message with the checked time window, whether bootstrap protection was active, and per-account counts for found tweets and quote-tweet candidates. If no trend alert was produced, the bot sends a second `Trend not detected` message. If a trend is found, the regular trend alert is sent as the second message.

Poll reports are sent to `TELEGRAM_LOG_CHAT_ID` and only include accounts that returned at least one tweet in that window. Detected trend alerts are sent separately to `TELEGRAM_ALERT_CHAT_ID`. Alerts and logs are intentionally split so a private channel can stay signal-only while a separate chat carries debugging noise.

## Trend Makers

Accounts in [`trend_makers.json`](/Users/turaljalilov/Documents/Trend tracker/trend_makers.json) are checked as potential trend sources. On every polling run, CT Trend Hunter scans their own non-reply, non-quote tweets over the configured lookback window and alerts if a tweet's quote count passes the same follower-tier Signal C threshold. Add trend makers to [`tracked_accounts.json`](/Users/turaljalilov/Documents/Trend tracker/tracked_accounts.json) as well when they should also be monitored as trend catchers.

## Immediate testing

To test the system right now without waiting for the morning schedule, run:

```bash
npm run build
npm run test:scan
```

That command performs a manual scan of the last 6 hours using the current tracked accounts and current `.env` flags.

- If `DRY_RUN=true`, alerts are only logged
- If `DRY_RUN=false`, Telegram alerts are actually sent
- If `SKIP_ALERTS_ON_FIRST_RUN=false`, the manual test run can alert immediately

## Seed file format

The sample [`tracked_accounts.json`](/Users/turaljalilov/Documents/Trend tracker/tracked_accounts.json) file contains:

```json
[
  { "username": "tier10k", "priority": 1 },
  { "username": "0xngmi", "priority": 2 }
]
```

## Recommended production deployment

- Run under `pm2`, `systemd`, Docker, or another process manager.
- Keep `DRY_RUN=false` in production.
- Back up the SQLite database regularly if alerts and history matter.
- Monitor logs for API schema drift from `twitterapi.io`.

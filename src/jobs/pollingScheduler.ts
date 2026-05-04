import { env } from "../config/env";
import { appStateRepository } from "../db/repositories";
import { DailySummaryService } from "../services/trends/dailySummaryService";
import { TrendMonitorService } from "../services/trends/trendMonitorService";
import {
  getCurrentSlotKey,
  getZonedParts,
  getLocalDateKey,
  getMorningCatchupWindow,
  getPollingWindow,
  isSlotBoundary,
  isWithinWorkHours
} from "../utils/time";
import { logger } from "../utils/logger";

export class PollingScheduler {
  private lastRunSlot: string | null = null;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly trendMonitorService: TrendMonitorService,
    private readonly dailySummaryService: DailySummaryService
  ) {}

  start(): void {
    logger.info("Starting scheduler", {
      timezone: env.timezone,
      workStartHour: env.workStartHour,
      workEndHour: env.workEndHour,
      pollMinutes: env.pollMinutes
    });

    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, 15_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();

    if (!isWithinWorkHours(now, env.timezone, env.workStartHour, env.workEndHour)) {
      logger.debug("Outside work hours, skipping tick");
      return;
    }

    if (!isSlotBoundary(now, env.timezone, env.pollMinutes)) {
      return;
    }

    const slotKey = getCurrentSlotKey(now, env.timezone, env.pollMinutes);
    const dateKey = getLocalDateKey(now, env.timezone);
    if (this.lastRunSlot === slotKey || this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.lastRunSlot = slotKey;

    try {
      const lastCatchupDateKey = appStateRepository.get("scheduler:last_catchup_date_key");
      const isFirstRunOfDay = lastCatchupDateKey !== dateKey;
      const window = isFirstRunOfDay
        ? getMorningCatchupWindow(now, env.timezone, env.morningCatchupSinceHour)
        : getPollingWindow(now, env.pollMinutes);

      logger.info("Running polling slot", {
        slotKey,
        since: window.since,
        until: window.until,
        isFirstRunOfDay
      });

      if (isFirstRunOfDay) {
        appStateRepository.set("scheduler:last_catchup_date_key", dateKey);
      }
      await this.trendMonitorService.pollWindow(window.since, window.until);

      const shouldSendDailySummary = getZonedParts(now, env.timezone).hour === env.workEndHour;
      if (shouldSendDailySummary) {
        const summaryStateKey = `scheduler:daily_summary_sent:${dateKey}`;
        if (appStateRepository.get(summaryStateKey) !== "1") {
          await this.dailySummaryService.sendDailySummary({
            dateKey,
            timezone: env.timezone,
            workStartHour: env.workStartHour,
            workEndHour: env.workEndHour
          });
          appStateRepository.set(summaryStateKey, "1");
        }
      }
    } finally {
      this.isRunning = false;
    }
  }
}

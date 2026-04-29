import fs from "node:fs";
import { env } from "../../config/env";
import { logger } from "../../utils/logger";

export interface TrendMakerConfigRecord {
  username: string;
  priority: number;
  lookbackHours: number;
  quoteThreshold?: number;
}

interface TrendMakerFileRecord {
  username: string;
  priority?: number;
  lookbackHours?: number;
  quoteThreshold?: number;
}

export const listTrendMakers = (): TrendMakerConfigRecord[] => {
  if (!fs.existsSync(env.trendMakersFile)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(env.trendMakersFile, "utf-8");
    const records = JSON.parse(raw) as TrendMakerFileRecord[];

    return records
      .map((record, index) => ({
        username: record.username.replace(/^@/, "").trim(),
        priority: record.priority ?? index + 1,
        lookbackHours: record.lookbackHours ?? env.ownTweetLookbackHours,
        quoteThreshold: record.quoteThreshold ?? undefined
      }))
      .filter((record) => record.username.length > 0)
      .sort((a, b) => a.priority - b.priority || a.username.localeCompare(b.username));
  } catch (error) {
    logger.error("Failed to load trend makers file", {
      file: env.trendMakersFile,
      error: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
};

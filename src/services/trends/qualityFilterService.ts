import fs from "node:fs";
import { env } from "../../config/env";
import { NormalizedTweet } from "../../types/twitter";
import { logger } from "../../utils/logger";

export type QualityIgnoreReason = "giveaway" | "project_account" | "project_update";

export interface QualityFilterResult {
  reason: QualityIgnoreReason;
  matched: string;
}

interface QualityFilterConfig {
  giveawayPatterns?: string[];
  projectUpdatePatterns?: string[];
}

const defaultGiveawayPatterns = [
  "\\bgiveaway\\b",
  // "airdrop" alone is too broad and can hide legitimate market/trend posts.
  "\\bairdrop\\b.{0,40}\\b(claim|join|win|winner|enter|entries?|rt|retweet|follow|tag)\\b",
  "\\b(claim|join|win|winner|enter|entries?|rt|retweet|follow|tag)\\b.{0,40}\\bairdrop\\b",
  "\\braffle\\b",
  "\\bwin\\b",
  "\\bwinners?\\b",
  "\\bentries? win\\b",
  "\\brt this\\b",
  "\\bretweet this\\b",
  "\\bfollow\\b.{0,40}\\brt\\b",
  "\\bfollow\\b.{0,40}\\bretweet\\b",
  "\\btag\\b.{0,20}\\bfriends?\\b",
  "\\bcomplete the survey\\b",
  "\\bsurvey\\b.{0,40}\\bwin\\b"
];

const defaultProjectUpdatePatterns = [
  "\\bintroducing\\b",
  "\\bannouncing\\b",
  "\\bwe('re| are) excited\\b",
  "\\bpartnership\\b",
  "\\bpartnered with\\b",
  "\\bnew feature\\b",
  "\\bnew product\\b",
  "\\bnow live\\b",
  "\\bpublic beta\\b",
  "\\bmainnet\\b",
  "\\btestnet\\b"
];

const normalizeText = (value: string): string => {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s@#+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const readJsonFile = <T>(file: string, fallback: T): T => {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (error) {
    logger.error("Failed to read quality filter config", {
      file,
      error: error instanceof Error ? error.message : String(error)
    });
    return fallback;
  }
};

const loadQualityConfig = (): Required<QualityFilterConfig> => {
  const config = readJsonFile<QualityFilterConfig>(env.qualityFiltersFile, {});
  return {
    giveawayPatterns: config.giveawayPatterns ?? defaultGiveawayPatterns,
    projectUpdatePatterns: config.projectUpdatePatterns ?? defaultProjectUpdatePatterns
  };
};

const loadProjectAccounts = (): Set<string> => {
  const records = readJsonFile<Array<string | { username: string }>>(env.projectAccountsFile, []);
  return new Set(
    records
      .map((record) => (typeof record === "string" ? record : record.username))
      .map((username) => username.replace(/^@/, "").trim().toLowerCase())
      .filter(Boolean)
  );
};

const findPatternMatch = (text: string, patterns: string[]): string | null => {
  for (const pattern of patterns) {
    if (new RegExp(pattern, "i").test(text)) {
      return pattern;
    }
  }
  return null;
};

export class QualityFilterService {
  evaluate(tweet: NormalizedTweet): QualityFilterResult | null {
    if (!env.enableQualityFilters) {
      return null;
    }

    const projectAccounts = loadProjectAccounts();
    const authorUsername = tweet.author.username.toLowerCase();
    if (projectAccounts.has(authorUsername)) {
      return { reason: "project_account", matched: tweet.author.username };
    }

    const config = loadQualityConfig();
    const text = normalizeText(tweet.text);
    const giveawayMatch = findPatternMatch(text, config.giveawayPatterns);
    if (giveawayMatch) {
      return { reason: "giveaway", matched: giveawayMatch };
    }

    const projectUpdateMatch = findPatternMatch(text, config.projectUpdatePatterns);
    if (projectUpdateMatch && /\b(we|our|introducing|announcing)\b/i.test(text)) {
      return { reason: "project_update", matched: projectUpdateMatch };
    }

    return null;
  }
}

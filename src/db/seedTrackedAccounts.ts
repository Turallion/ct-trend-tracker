import fs from "node:fs";
import { env } from "../config/env";
import { trackedAccountRepository } from "./repositories";
import { logger } from "../utils/logger";

interface SeedRecord {
  username: string;
  priority?: number;
}

const raw = fs.readFileSync(env.trackedAccountsFile, "utf-8");
const records = JSON.parse(raw) as SeedRecord[];

const normalized = records.map((record, index) => ({
  username: record.username.replace(/^@/, "").trim(),
  priority: record.priority ?? index + 1
}));

trackedAccountRepository.replaceAllActive(normalized);
logger.info("Tracked accounts seeded", { count: normalized.length, source: env.trackedAccountsFile });

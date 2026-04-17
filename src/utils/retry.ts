import { logger } from "./logger";

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export const withRetry = async <T>(
  taskName: string,
  attempts: number,
  fn: (attempt: number) => Promise<T>
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      logger.warn("Task attempt failed", {
        taskName,
        attempt,
        attempts,
        error: error instanceof Error ? error.message : String(error)
      });

      if (attempt < attempts) {
        await sleep(attempt * 500);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Task failed: ${taskName}`);
};

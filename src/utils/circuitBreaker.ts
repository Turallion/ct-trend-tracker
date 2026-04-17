import { logger } from "./logger";

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  constructor(name: string) {
    super(`Circuit breaker '${name}' is open`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly name: string,
    private readonly failureThreshold: number,
    private readonly cooldownMs: number
  ) {}

  getState(): CircuitState {
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(this.name);
      }
      this.transitionTo("half_open");
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error);
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === "half_open" || this.state === "open") {
      this.transitionTo("closed");
    }
    this.consecutiveFailures = 0;
  }

  private onFailure(error: unknown): void {
    // Circuit-open errors should not re-trip the counter
    if (error instanceof CircuitOpenError) {
      return;
    }

    this.consecutiveFailures += 1;

    if (this.state === "half_open") {
      this.transitionTo("open");
      return;
    }

    if (this.state === "closed" && this.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo("open");
    }
  }

  private transitionTo(next: CircuitState): void {
    const prev = this.state;
    this.state = next;
    if (next === "open") {
      this.openedAt = Date.now();
    }
    if (next === "closed") {
      this.consecutiveFailures = 0;
      this.openedAt = 0;
    }
    logger.info("Circuit breaker state change", {
      name: this.name,
      previous: prev,
      next,
      consecutiveFailures: this.consecutiveFailures
    });
  }
}

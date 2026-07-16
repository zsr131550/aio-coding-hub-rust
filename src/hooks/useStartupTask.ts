import { useEffect } from "react";
import { logToConsole } from "../services/consoleLog";

/**
 * Runs a fire-and-forget async task once on mount with standardised error logging.
 *
 * @param task    - Async function to execute.
 * @param stage   - Label used for warning logs on failure.
 * @param message - Human-readable failure description for logs.
 * @param enabled - Whether the task should run.
 */
export function useStartupTask(
  task: () => Promise<unknown>,
  stage: string,
  message: string,
  enabled = true
) {
  useEffect(() => {
    if (!enabled) return;

    task().catch((error) => {
      logToConsole("warn", message, {
        stage,
        error: String(error),
      });
    });
  }, [enabled, message, stage, task]);
}

/** A promise that did not answer in time; distinct so a caller can say so. */
export class TimeoutError extends Error {
  readonly afterMs: number;

  constructor(what: string, afterMs: number) {
    super(`${what} timed out after ${Math.round(afterMs / 1000)}s`);
    this.name = "TimeoutError";
    this.afterMs = afterMs;
  }
}

/**
 * Give up on a promise that has not answered within `ms`.
 *
 * Tauri commands carry no deadline of their own, so a backend that wedges
 * leaves the caller awaiting forever — in a button handler that is a
 * spinner that never stops and a button that never comes back. The
 * rejection is a [`TimeoutError`], which callers report by name.
 *
 * Nothing here stops the command: it is already running in the backend and
 * there is no cancel token to hand it, so the choice is between waiting
 * forever and reporting honestly that no answer has arrived. `what` only
 * names the wait in the error message.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

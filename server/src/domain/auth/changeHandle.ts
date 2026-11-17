import { HandleTakenError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { assertValidHandle, handleKey } from "./shared.js";

/**
 * Handle change. The new handle must be valid and free; a case-only
 * change (same key, different casing) is allowed and returns the renamed
 * user. The account id never changes, so ownership, sessions and the
 * sync cursor are unaffected — only the denormalised `owner_handle`
 * joins (and this client's greeting) pick up the new name.
 */
export async function changeHandle(
  deps: AuthDeps,
  user: UserRecord,
  newHandle: string,
): Promise<UserRecord> {
  assertValidHandle("handle", newHandle);

  const handle = newHandle.trim();
  const key = handleKey(newHandle);

  if (key !== user.handleKey) {
    const existing = await deps.users.findByHandleKey(key);
    if (existing) {
      throw new HandleTakenError();
    }
  }

  return deps.users.updateHandle(user.id, handle, key);
}

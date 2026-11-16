import { ForbiddenError, InvalidRecoveryCodeError } from "../errors.js";
import type { AuthDeps, UserRecord } from "../ports.js";
import { assertValidPassword, handleKey } from "./shared.js";

/**
 * Makes (or replaces) the account's recovery code. Needs the current
 * password: a stolen session alone must not be able to mint the key
 * that later resets the password. Any earlier code stops working.
 * Returns the code once; only its hash is stored.
 *
 * A wrong password is 403, not 401: clients treat a 401 on a signed-in
 * request as "session expired" and sign the person out, which a typo
 * must not do.
 */
export async function issueRecoveryCode(
  deps: AuthDeps,
  user: UserRecord,
  currentPassword: string,
): Promise<{ recoveryCode: string }> {
  const ok = await deps.hasher.verify(user.passwordHash, currentPassword);
  if (!ok) {
    throw new ForbiddenError("Current password is incorrect");
  }
  const { code, codeHash } = deps.tokens.generateRecoveryCode();
  await deps.users.setRecoveryCodeHash(user.id, codeHash);
  return { recoveryCode: code };
}

/**
 * Forgot-password reset. The recovery code stands in for the old
 * password. It works exactly once: a fresh code is issued in its place
 * (returned for the person to save), and every session of the account
 * is revoked, including the thief's if the old password had leaked.
 * Unknown handle, no code on file and wrong code are one error.
 * The route's brute-force limiter stands in front of this.
 */
export async function resetPassword(
  deps: AuthDeps,
  input: { handle: string; recoveryCode: string; newPassword: string },
): Promise<{ recoveryCode: string; revoked: number }> {
  assertValidPassword("new_password", input.newPassword);

  const user = await deps.users.findByHandleKey(handleKey(input.handle));
  if (
    !user ||
    !user.recoveryCodeHash ||
    user.recoveryCodeHash !== deps.tokens.hashRecoveryCode(input.recoveryCode)
  ) {
    throw new InvalidRecoveryCodeError();
  }

  await deps.users.updatePasswordHash(
    user.id,
    await deps.hasher.hash(input.newPassword),
  );
  const { code, codeHash } = deps.tokens.generateRecoveryCode();
  await deps.users.setRecoveryCodeHash(user.id, codeHash);
  // No token hash is "" so nothing is kept: every device signs out.
  const revoked = await deps.sessions.deleteOthersForUser(user.id, "");
  return { recoveryCode: code, revoked };
}

export { registerUser } from "./register.js";
export type { RegisterInput, RegisterResult } from "./register.js";
export { loginUser } from "./login.js";
export type { LoginInput, LoginResult } from "./login.js";
export { changePassword } from "./password.js";
export { changeHandle } from "./changeHandle.js";
export { issueRecoveryCode, resetPassword } from "./recovery.js";
export {
  DEVICE_LABEL_MAX,
  deviceLabelFromUserAgent,
  listUserSessions,
  logoutUser,
  MAX_SESSIONS_PER_USER,
  purgeExpiredSessions,
  revokeOtherSessions,
  revokeSession,
  SESSION_TOUCH_INTERVAL_MS,
  validateSession,
} from "./session.js";
export type { SessionResult, SessionView } from "./session.js";
export {
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_PATTERN,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assertValidHandle,
  assertValidPassword,
  handleKey,
} from "./shared.js";

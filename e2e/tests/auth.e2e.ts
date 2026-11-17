import { expect, test } from "@playwright/test";
import { pc } from "../support/fixtures";
import { readStackState } from "../support/stack-state";
import { testids } from "../support/testids";

// F1 (REFACTORING.md section 11): register on the sign-in screen and
// reach the shell; wrong passwords stay on the form with the error; a
// handle that differs only by case is "already in use" (409); sign out
// returns to sign-in and signing in again reopens the app.

test("F1 sign up, sign in, case-duplicate, sign out, sign in again", async ({
  browser,
}) => {
  const { apiUrl } = readStackState();
  const handle = `F1User${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const seeded = await pc(browser);
  const page = await seeded.context.newPage();
  await page.goto("/");
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });

  // Register a new account.
  await page.getByTestId(testids.authUrl).fill(apiUrl);
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page.getByRole("button", { name: "Create account" }).click();
  // The new account's recovery code is shown once; the app opens only
  // after the person confirms they saved it.
  await expect(page.getByTestId(testids.recoveryCode)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId(testids.recoveryContinue).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // The top-bar user badge opens Profile, which shows who is signed in
  // and signs out in one click.
  await page.getByTestId(testids.topbarProfile).click();
  await expect(page).toHaveURL(/\/settings\?section=profile/);
  await expect(page.getByTestId(testids.profileHandle)).toHaveText(handle, {
    timeout: 15_000,
  });
  await page.getByTestId(testids.profileSignOut).click();
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });

  // Wrong password shows the error and stays on the form.
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Invalid handle or password")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId(testids.signinForm)).toBeVisible();

  // A handle that differs only by case is already in use (409).
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page.getByTestId(testids.authHandle).fill(handle.toLowerCase());
  await page.getByTestId(testids.authPassword).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByText("Handle already taken")).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByTestId(testids.signinForm)).toBeVisible();

  // Signing in again reopens the app.
  await page
    .getByRole("button", { name: "Already have an account? Sign in" })
    .click();
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
});

// F2: a forgotten password. Register and read the one-time recovery
// code, sign out, reset with it, and check the old password and the old
// code are dead while the new password and the replacement code work.
test("F2 forgot password: reset with the recovery code", async ({
  browser,
}) => {
  const { apiUrl } = readStackState();
  const handle = `F2User${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const password = "password123";
  const newPassword = "a-brand-new-password";
  const codeShape = /^([A-Z2-9]{5}-){3}[A-Z2-9]{5}$/;
  const seeded = await pc(browser);
  const page = await seeded.context.newPage();
  await page.goto("/");
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });

  // Register and read the code off the screen.
  await page.getByTestId(testids.authUrl).fill(apiUrl);
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page
    .getByRole("button", { name: "New here? Create an account" })
    .click();
  await page.getByRole("button", { name: "Create account" }).click();
  const firstCode =
    (await page.getByTestId(testids.recoveryCode).textContent())?.trim() ?? "";
  expect(firstCode).toMatch(codeShape);
  await page.getByTestId(testids.recoveryContinue).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });

  // Sign out, then reset the password with the code.
  await page.getByTestId(testids.topbarProfile).click();
  await page.getByTestId(testids.profileSignOut).click();
  await expect(page.getByTestId(testids.signinForm)).toBeVisible({
    timeout: 15_000,
  });
  await page.getByTestId(testids.authForgotPassword).click();
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authRecoveryCode).fill(firstCode);
  await page.getByTestId(testids.authPassword).fill(newPassword);
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();

  // A replacement code is shown; the reset signs nobody in.
  await expect(page.getByTestId(testids.recoveryCode)).toBeVisible({
    timeout: 15_000,
  });
  const secondCode =
    (await page.getByTestId(testids.recoveryCode).textContent())?.trim() ?? "";
  expect(secondCode).toMatch(codeShape);
  expect(secondCode).not.toBe(firstCode);
  await page.getByTestId(testids.recoveryContinue).click();
  await expect(page.getByTestId(testids.signinForm)).toBeVisible();
  // The reset signs nobody in. AuthGate keeps the shell mounted but hidden
  // after sign-out, so assert hidden rather than removed from the DOM.
  await expect(page.getByTestId(testids.shellApp)).toBeHidden();

  // The first code was single-use: it no longer resets anything.
  await page.getByTestId(testids.authForgotPassword).click();
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authRecoveryCode).fill(firstCode);
  await page.getByTestId(testids.authPassword).fill("another-new-password");
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click();
  await expect(page.getByText("Invalid handle or recovery code")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByRole("button", { name: "Back to sign in" }).click();

  // The old password is dead, the new one opens the app.
  await page.getByTestId(testids.authHandle).fill(handle);
  await page.getByTestId(testids.authPassword).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Invalid handle or password")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByTestId(testids.authPassword).fill(newPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId(testids.shellApp)).toBeVisible({
    timeout: 15_000,
  });
});

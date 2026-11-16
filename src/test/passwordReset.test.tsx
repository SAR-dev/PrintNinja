import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@/lib/i18n";
import { AuthGate } from "@/components/AuthGate";

const SERVER = "http://server.test";
const URL_KEY = "printninja-setting:share_service_url";
const TOKEN_KEY = "printninja-setting:share_session_token";

const tauriInvoke = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => tauriInvoke.fn(...a),
}));

type Handler = (url: string, body: unknown) => Response | Promise<Response>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let handler: Handler;
let requests: Array<{ url: string; body: unknown }>;

beforeEach(() => {
  localStorage.clear();
  // Signed out, with the server address remembered from an earlier run.
  localStorage.setItem(URL_KEY, SERVER);
  requests = [];
  vi.stubEnv("VITE_DEFAULT_SHARE_URL", "");
  handler = () => json({}, 404);
  tauriInvoke.fn.mockReset();
  tauriInvoke.fn.mockImplementation(
    async (cmd: string, args?: { key?: string; value?: string }) => {
      if (cmd === "list_templates") return [];
      if (cmd === "get_setting")
        return localStorage.getItem(`printninja-setting:${args?.key}`);
      if (cmd === "set_setting" && args?.key) {
        if (args.value) {
          localStorage.setItem(`printninja-setting:${args.key}`, args.value);
        } else {
          localStorage.removeItem(`printninja-setting:${args.key}`);
        }
      }
      return null;
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req =
        input instanceof Request ? input : new Request(input as string, init);
      const text = req.method === "GET" ? "" : await req.text();
      const body = text ? JSON.parse(text) : undefined;
      // The gate's startup probe: a remembered address, no session yet,
      // so it only checks that the server is there.
      if (req.url.endsWith("/v2/health")) return json({ status: "ok" });
      requests.push({ url: req.url, body });
      return handler(req.url, body);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function renderGate() {
  return render(
    <AuthGate>
      <h1>The app</h1>
    </AuthGate>,
  );
}

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const CODE = "ABCDE-FGHJK-LMNPQ-RSTUV";
const NEW_CODE = "WXYZ2-34567-89ABC-DEFGH";

describe("recovery code at registration", () => {
  it("holds on the code until the person says it is saved", async () => {
    handler = (url) =>
      url === `${SERVER}/v2/auth/register`
        ? json(
            {
              token: "tok",
              expires_at: "2027-01-01T00:00:00Z",
              user: { id: "u1", handle: "newbie" },
              recovery_code: CODE,
            },
            201,
          )
        : json({}, 404);
    renderGate();
    await screen.findByLabelText("Password");
    fireEvent.click(screen.getByRole("button", { name: /create an account/i }));
    type("Handle", "newbie");
    type("Password", "longenough");
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByTestId("recovery-code")).toHaveTextContent(CODE);
    // Signed up, but the app is not even mounted until the code is acknowledged.
    expect(screen.queryByText("The app")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("recovery-continue"));
    expect(await screen.findByText("The app")).toBeVisible();
    expect(localStorage.getItem(TOKEN_KEY)).toBe("tok");
  });
});

describe("forgot password", () => {
  async function openResetForm() {
    renderGate();
    await screen.findByLabelText("Password");
    fireEvent.click(screen.getByTestId("auth-forgot-password"));
    await screen.findByLabelText("Recovery code");
  }

  it("resets with the code, shows the new code, then returns to sign-in", async () => {
    handler = (url) =>
      url === `${SERVER}/v2/auth/reset-password`
        ? json({ recovery_code: NEW_CODE, revoked: 2 })
        : json({}, 404);
    await openResetForm();

    // Reset mode: no guest entry, the password field is the *new* one.
    expect(
      screen.queryByRole("button", { name: "Continue as guest" }),
    ).not.toBeInTheDocument();
    type("Handle", "sam");
    type("Recovery code", "abcde fghjk lmnpq rstuv");
    type("New password", "a brand new pw");
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByTestId("recovery-code")).toHaveTextContent(
      NEW_CODE,
    );
    expect(requests.at(-1)).toEqual({
      url: `${SERVER}/v2/auth/reset-password`,
      body: {
        handle: "sam",
        // Sent as typed; the server normalises case, spaces and dashes.
        recovery_code: "abcde fghjk lmnpq rstuv",
        new_password: "a brand new pw",
      },
    });

    // Not signed in: every session was revoked. Back to the sign-in
    // form with the handle still filled in.
    fireEvent.click(screen.getByTestId("recovery-continue"));
    expect(await screen.findByLabelText("Handle")).toHaveValue("sam");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(screen.queryByText("The app")).not.toBeInTheDocument();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("shows the server's message for a wrong code and stays on the form", async () => {
    handler = () =>
      json(
        {
          error: {
            code: "invalid_credentials",
            message: "Invalid handle or recovery code",
            request_id: "r1",
          },
        },
        401,
      );
    await openResetForm();
    type("Handle", "sam");
    type("Recovery code", "WRONG");
    type("New password", "a brand new pw");
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid handle or recovery code",
    );
    expect(screen.getByLabelText("Recovery code")).toBeInTheDocument();
  });

  it("checks the fields locally before calling the server", async () => {
    await openResetForm();
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /recovery code and a new password/i,
    );

    type("Handle", "sam");
    type("Recovery code", CODE);
    type("New password", "short");
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /at least 8 characters/i,
      ),
    );
    expect(requests).toEqual([]);
  });

  it("goes back to sign in without keeping what was typed", async () => {
    await openResetForm();
    type("Recovery code", CODE);
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(await screen.findByLabelText("Password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery code")).not.toBeInTheDocument();
  });
});

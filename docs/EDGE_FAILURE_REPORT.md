# PrintNinja: PDF printing fails when run as administrator

Investigation report, 6 November 2026. Repository: SAR-dev/PrintNinja, branch `develop` (commit 2479825).

## 1. Summary

Printing from the demo template (`/server/public/demo/print.html`) fails with `Edge print-to-pdf did not produce a PDF (status exit code: 0, stderr: )`. The built-in 'Fix PC printing' repair does not help, and its own test render fails too.

**Finding:** headless Edge works on this PC when launched from a normal (non-elevated) PowerShell, and fails in exactly the way the app reports when launched from an **Administrator** PowerShell. Edge exits with code 0 after about 180 ms, writes no PDF and prints nothing to stderr. Nothing else changed between the two runs.

**Most probable cause:** PrintNinja is being run elevated (as administrator) on this PC, and Edge cannot render when its parent process is elevated. This is an inference. It has not yet been confirmed by checking the app's own elevation, and the exact mechanism inside Edge is not verified.

**Recommendation:** start the app normally now. In the app, detect elevation and report it clearly, then make printing work when elevated by launching Edge de-elevated. Downloading Chromium is not recommended.

## 2. Symptoms

The app log showed three warnings in a row:

- The persistent profile was in use, so it started on a fresh one.
- The persistent Edge could not render: the browser exited while starting (exit code 0), and the profile may be in use.
- Edge failed on the reusable profile, so it retried on a throwaway one (exit code 0, empty stderr).

'Fix PC printing' reported: Edge found, running Edge windows closed, 2 stale profiles removed, cooldown reset, test render failed with the same error.

## 3. How the app renders (from the source)

The Windows render path is in `src-tauri/src/render/`:

- `cdp.rs` starts one long-lived headless Edge with `--headless=new --remote-debugging-port=0` and drives it over DevTools. If the process exits before it publishes a port, it reports `ExitedWhileStarting`, and its message assumes the profile is owned by another browser.
- `edge.rs` is the fallback. It starts `msedge.exe` once per job with `--print-to-pdf=<file>` on a reusable or throwaway profile.
- `mod.rs` builds the arguments and reports 'did not produce a PDF' whenever the process exits and no file exists.
- `fix.rs` closes Edge, deletes profile folders and re-runs a test render with a trivial one-page HTML document.

The code assumes that exit code 0 with no PDF means Edge handed its command line to another running Edge that owns the same profile. That assumption cannot hold for a freshly created profile, which is why the repair never had a chance of working here. Neither path captures Edge's own log output.

## 4. How the conclusion was reached

### 4.1 What the logs already rule out

- **The template:** the repair's test render prints trivial HTML and also fails.
- **Stale profiles or Edge processes:** the repair closed Edge and deleted the profiles, and the new profiles were brand new.
- **A single code path:** both the CDP launch and the `--print-to-pdf` launch fail the same way.

### 4.2 Direct tests on the PC

I cannot run Windows here, so I asked for manual tests in PowerShell. The Edge version was 156.0.4314.58.

| Test | What it varied | Result |
| --- | --- | --- |
| a, b, c | `--headless=new` and old `--headless`, forward and back slashes in the PDF path, `data:` URL | All wrote a PDF. About 39 `msedge` and 27 `msedgewebview2` processes were running at the time |
| d1 to d4 | App's full flag set, `file:///` URL, profile inside the app's AppData folder, hidden window | All wrote a PDF in a normal shell |
| e1 to e4 (normal shell) | App-style spawn: no window, stdin closed, stdout and stderr piped. PDF and HTML inside the app's cache folder. The app's own `last-render.html` | All wrote a PDF in about 1.9 s |
| e1 to e4 (**Administrator shell**) | Same script, same files | **All failed: exit 0 in 165 to 258 ms, no PDF, empty stderr** |

The Administrator run reproduces the app's symptom exactly: exit code 0, empty stderr and a few hundred milliseconds.

### 4.3 Hypotheses discarded

- Edge blocked by policy or security software: it works in a normal shell.
- Backslash in the output path: test b worked with a backslash.
- Other Edge or WebView2 processes running: tests passed with dozens running.
- A stale or in-use profile: fresh profiles in a normal shell work, and the failure in the elevated shell occurs on fresh ones too.
- Specific flags, the `file:///` URL, the AppData folder or the hidden window: all passed in a normal shell.

### 4.4 Mistakes along the way

Two of my earlier tests were invalid, so I am recording them here. The first Administrator run reused PDF file names from the normal run, so `Test-Path` passed on stale files. The next script failed because `R` is a built-in PowerShell alias for `Invoke-History`, so no test ran. The conclusion in section 4.2 comes from the corrected script, which deletes old PDFs first and uses a function name that is not an alias.

### 4.5 Why the app is probably running elevated

The repository does not request administrator rights anywhere (no `requireAdministrator` or similar in `tauri.conf.json`, `build.rs` or any manifest). So if the app is elevated, it is being started that way: 'Run as administrator', the shortcut's Compatibility setting, or an admin terminal if run with `pnpm tauri dev`. **This is still unconfirmed.** It has not yet been checked how the app is started on this PC.

### 4.6 Side finding: Edge is policy-managed

In the normal-shell runs Edge logged a harmless error trying to download an IE-mode site list from a company file share. The PC has a company or domain Edge policy. It is not the cause, but other policies may exist.

## 5. What is not verified

- That the app process itself is elevated when it fails.
- The mechanism inside Edge. An immediate exit with 0 looks like a hand-off to another process that fails when the caller is elevated.
- That Edge 156 elevation behaviour matches other Edge versions.
- Whether `--no-sandbox`, a downloaded Chromium or WebView2 printing behave differently when elevated.

No code in the repository has been changed.

## 6. Possible fixes

### Fix 0: Run the app normally (workaround)

Start PrintNinja without 'Run as administrator' and remove any Compatibility setting that forces it.

- **Pros:** no code change, takes a minute, directly matches the test result.
- **Cons:** does not help if the app must run elevated, for example for a printer or USB port that needs it. Users can forget and hit the same error.

### Fix 1: Detect elevation and explain it (in the app)

Check whether the process is elevated when a render fails and in 'Fix PC printing'. Log the exact command line, the elevation state and Edge's real stderr (`--enable-logging=stderr`). Show the repair as a step-by-step list with live status, and never report 'profile in use' when a fresh profile exits 0.

- **Pros:** small and low risk. Turns a confusing 500 into an actionable message. Gives clear diagnostics for any future cause. Meets the goal of showing the user what is happening.
- **Cons:** does not make printing work when elevated. It only explains why it fails.

### Fix 2: Launch Edge de-elevated from the elevated app

When the app is elevated, start `msedge.exe` with the normal-user token of the logged-in desktop (the standard shell-token technique, or the shell's own launch mechanism).

- **Pros:** keeps the existing Edge and DevTools pipeline, so layout and output stay identical. Fixes the real cause. No large download.
- **Cons:** needs Win32 code and testing. Pipes cannot always be inherited across this launch, so output would go to log files and the process would be watched differently. It does not work with no logged-in desktop session, such as a service, or if the elevated account differs from the desktop user.

### Fix 3: Print through the WebView2 the app already uses

Render the HTML in a hidden WebView2 and call its built-in print-to-PDF, with no `msedge.exe` launch at all.

- **Pros:** the app's own UI already depends on WebView2, so the runtime is guaranteed. No profiles, no hand-off, no elevation issue expected (not yet verified).
- **Cons:** the largest change. It must be proven to honour the `@page` size and margin rules the layout relies on, and to handle concurrent jobs. Output could differ slightly from the current Edge output.

### Fix 4: Try `--no-sandbox` when elevated

An untested quick experiment: add `--no-sandbox` to the elevated launch. The Linux code path already adds it when running as root.

- **Pros:** one flag, easy to test in an Administrator shell.
- **Cons:** it may not help, because the cause is not shown to be the sandbox. It switches off a security layer, which is risky if any template loads remote content. Edge policy on a managed PC may also interfere. I would only use it with strong evidence and limited to trusted local content.

### Fix 5: Download and use Chromium or `chrome-headless-shell`

Fetch a pinned browser on first use and render with it.

- **Pros:** independent of the system Edge and its policies. Headless shell is built for print-to-PDF.
- **Cons:** the problem here is not a missing browser, since Edge prints fine when not elevated. A download of roughly 100 to 200 MB needs hosting or a pinned source, checksum checks and an update plan. It fails offline and may be blocked by security software or policy. It may also fail the same way when elevated, which is unverified. **Not recommended.**

## 7. Recommended plan

1. **Now:** run PrintNinja non-elevated and confirm printing works. This also confirms the diagnosis.
2. **Confirm the cause on the app side:** check how the app is launched, and add the elevation check and logging from Fix 1.
3. **Implement Fix 1** (clear message and step-by-step repair with real Edge output).
4. **If elevated use is required:** prototype Fix 2 first because it keeps output identical. Evaluate Fix 3 as a longer-term option.
5. **Do not build Fix 5** unless evidence shows Edge cannot be made to work on some PCs for other reasons.

## 8. Questions for the owner

- Is PrintNinja intentionally run as administrator on this PC, and if so why?
- Is the logged-in desktop user the same account that runs it elevated?
- Should the app keep working when elevated, or is a clear 'please restart normally' message acceptable?

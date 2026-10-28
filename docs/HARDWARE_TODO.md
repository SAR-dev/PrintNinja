# Hardware TODO

Checks that need physical devices. Everything here is verified by hand
because no emulator, printer, or second machine exists in this
environment. Code changes that enable each check are done; what is
missing is the run itself. Check an item off only after running it —
code reading is not proof.

Conventions: A = Android phone with the app installed from `develop`,
B = PC (Windows or Linux) with the desktop app from `develop`, same
Wi-Fi, LAN API sharing on (default port 17717, firewall open).

## Thermal printing through a paired PC

- [ ] **Fresh install opens on pairing.** Install the app on a phone
      with no paired PC and open it: expect the pairing screen, not the
      app. Pair by typing the PC's 8-character code, expect the app to
      open. Unpair afterwards and reopen: expect the gate again.
- [ ] **ESC/POS over USB from the phone.** Pair A to B (Automation → Phones,
      typed code or, when the search finds nothing, the PC's
      address). On A, add the USB thermal printer
      (type USB, address = device name, language defaults to ESC/POS
      when paired) and print a receipt template. Expect real receipt
      bytes on paper and a History row rendered by B — not a PDF, not
      blank paper.
- [ ] **ZPL or TSPL over Bluetooth from the phone.** Pair a Bluetooth
      label printer (address = MAC), language ZPL/TSPL, print a label.
      Expect a printed label. On the first attempt the permission dialog
      appears; granting it continues the same print (no second tap).
      Denying it must fail with the Settings-screen message, not a hang.
- [ ] **PC off.** With B's server stopped, print any job from A
      (thermal or PDF — everything renders on the PC now). Expect a
      fast, clear failure naming the PC ("no paired PC answered …
      <PC> is blocked or unreachable …" or "<PC> refused the connection
      …"), not "cannot rasterize" and not a hang. Then retry the same
      job from History with B back on: expect it to print. While B is
      down, the amber "Can't reach <PC>" strip must already be showing
      on A (within about 30 s, or at once on a page change or "Check
      again") — before any print is attempted.
- [ ] **PC busy.** Start a long print on B, then print a thermal job
      from A. Expect A to wait for B (a few seconds) and then print —
      not an instant local failure.
- [ ] **PC asleep.** Let a Windows laptop sleep (or suspend a Linux
      box) with A paired, wait a minute, then print from A. Expect the
      same fast failure as "PC off", worded "<PC> is blocked or
      unreachable (no answer on port 17717) …" — not a hang, and not a
      "refused" message (a sleeping PC does not answer at all). Wake B,
      tap "Check again" on the strip, and retry the job from History:
      expect it to print without re-pairing.
- [ ] **Firewall on a fresh Windows PC.** On a Windows PC that has never
      allowed PrintNinja through Windows Defender Firewall, turn on
      Wi-Fi access, pair A, and press Test in Settings → Devices. Record
      what the Windows prompt did and what A shows. If the prompt was
      dismissed or denied, expect "<PC> is blocked or unreachable (no
      answer on port 17717). Check that the PC is on and awake, on the
      same Wi-Fi, and that its firewall allows PrintNinja." — not a
      bare "probe timeout". Then allow the app in the firewall and
      press Test again: expect the score line. If the wording did not
      help you find the cause, change only the wording.
- [ ] **PC state before printing.** With B on, open A's app: no strip.
      Turn B off, wait up to 30 s without touching A: the amber strip
      names B. Turn B on, tap "Check again": the strip goes away. The
      strip's "Devices" link must open Settings on the pairing card.
- [ ] **PDF through the PC.** With B paired, print a PDF to a network
      printer from A. Expect a normal print rendered by B (History
      shows who rendered it).

## Windows PDF and probes

- [ ] **PDF to a real laser/inkjet queue from Windows.** Print a PDF
      template to a system printer. Expect a correct page — this
      confirms or refutes sending a PDF as a PDF datatype.
- [ ] **Offline spooler/CUPS queue.** Stop the printer or take the
      queue offline and test-print. Expect a fast failure naming the
      reason (offline, paper out, jam) *before* any render happens.

## Android parity

- [ ] **Network discovery.** On the phone's network, expose an IPP
      printer (and a JetDirect one), open the add-printer panel, tap
      Scan, and check both appear without typing anything. Tapping one
      must fill name, address and type (ESC/POS default for the
      JetDirect box when paired).
- [ ] **USB/Bluetooth status.** With the thermal printer out of paper
      (or cover open), test-print from the phone. Expect a "paper out"
      style refusal before the job is sent.

## Desktop transports

- [ ] **Raw-capable CUPS queue.** Send ESC/POS or ZPL through a CUPS
      raw queue on Linux and confirm the bytes reach the head
      unaltered.
- [ ] **AppImage without a system Chromium.** Run the AppImage on a
      machine with no Chromium on PATH and confirm printing reports
      the missing renderer instead of a placeholder.

## Discovery and device lists

The code for these is in; none has run on a device.

- [ ] **USB and Bluetooth lists are not empty.** On A, attach a USB
      printer and have a paired Bluetooth printer in range, open the
      add-printer sheet. Expect both to appear. An empty list here was
      the suspected wrapper bug (the Kotlin side answers with an object, the
      Rust side wanted a bare list); if it is still empty,
      look for the new `tracing::warn!` line in the app log, which now
      says whether the call failed.
- [ ] **Several network printers, none missed.** Put three IPP or
      JetDirect printers on the Wi-Fi, tap Scan once. Expect all three
      (before Android 14 a second concurrent resolve used to drop
      printers; discovery now resolves one at a time).
- [ ] **CUPS-shared printer prints after a scan.** Share a queue from a
      CUPS box (resource path `printers/<Name>`), add it from the scan
      without typing anything, print. Expect a page. Also try a printer
      that advertises no `rp`: expect it to default to `ipp/print`.
- [ ] **IPv6-only or IPv6-advertising printer.** If one is available,
      scan and print. Expect a bracketed address with no `%scope`.

## Desktop printing correctness

- [ ] **Windows datatype list.** For the laser or inkjet queue used in
      "PDF to a real laser/inkjet queue" above, record which datatypes
      its print processor offers (Print Management, or the app log if
      the `no PDF datatype` warning appears). Expect a correct page
      either way. If the queue offers no `PDF`, record whether the RAW
      fallback printed a real page or the PDF source; that decides
      whether `choose_datatype` in `windows_spooler.rs` should fail
      instead of falling back.
- [ ] **Error 1804 wording.** If any queue rejects a datatype, record
      the message A or B shows. Expect "does not accept <type> jobs
      (Windows error 1804 …)".
- [ ] **Stopped CUPS queue.** On Linux run `cupsdisable <queue>`, then
      press Test on that printer. Expect a fast failure reading
      "CUPS queue `<queue>` is stopped" before any render. Then
      `cupsenable` and `cupsreject <queue>`: expect "is not accepting
      jobs". Then `cupsaccept` and Test: expect it to pass.
- [ ] **Paper out and low toner on a CUPS queue.** With a real printer
      behind CUPS, open the tray: expect a refusal naming paper. With
      only a low-toner warning, expect the probe to pass.

## CI timings

- [ ] **Release run is warm.** After this lands on `main`, merge once,
      then tag. In the tag run open `rust-lint` and `rust-test` and
      look at the rust-cache step: it must say a cache was restored,
      not "No cache found". Record the `rust-check` wall time before
      and after in the results log below.
- [ ] **Branch protection.** Require the `web-check`, `rust-check`,
      `rust-test-windows`, `server-check` and `android-check` statuses
      in the branch rules instead of merging on green alone.

## Gradle and Android Gradle plugin 10

The log lives in the Actions run for the tag, so this one is yours.

- [ ] **Search the latest `android-build` log.** In the Actions UI,
      filter the tag run's logs for the android build section and
      grep it for `newDsl|builtInKotlin`.
      No output: tick the box. Output: patch
      `src-tauri/gen/android/build.gradle` (or the `tauri android
      init` template) before AGP 10, and note the line here.

## When an item fails

Add a row to the results log below with the observed message, the
printer model and which device rendered, and open an issue for it.
Leave the box unchecked.

## Results log

One row per run, newest first. Fill it in when you tick a box above; a
box with no row here is not done.

| Date | Item | Devices (A phone / B PC / printer model) | Result | Message seen, if any |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

# 🚧 Known limitations

> **Who this is for:** anyone who tried something that did not work, and wants to know whether it is a bug or simply not supported yet.
> **What you will know after reading:** what PrintNinja cannot do today, what you will see when you try, and what to do instead.

These are not bugs. They are things we looked at and decided not to build — or not build yet. If something you expected is missing from this list, [tell us](https://github.com/SAR-dev/PrintNinja/issues).

**Jump to:** [🖨️ Printers](#printers) · [🏷️ Labels](#labels) · [📱 Phone and PC](#phone-and-pc) · [💻 Platforms](#platforms) · [🧪 Real printers](#real-printers)

<a id="printers"></a>

## 🖨️ Printers

**🪟 On Windows, USB printers go through Windows.** The printer must be installed in Windows first (**Printers & scanners**, then **Add device**); it then appears in PrintNinja under **System**. Jobs are sent to the spooler as `RAW`, so a PDF only prints if the printer itself reads PDF. Bluetooth is different: it can use the paired device's COM port directly, bypassing the spooler.

**🛡️ Printing on Windows while the app runs as administrator does not work.** The printing browser does nothing when its parent app is elevated, and PrintNinja shows a "restart normally" message. Start the app without "Run as administrator", and remove any Compatibility setting that forces it.

**🐧 On Linux, USB printers go through CUPS.** Create a CUPS queue — a **raw** queue for thermal and label printers, for example `lpadmin -p MyPrinter -m raw -v usb://...` — and add it in PrintNinja as a **System** printer. Bluetooth dials the paired device directly instead.

**📡 Some printers cannot be asked "are you ready to print?"** Before a raw job is sent, ESC/POS, ZPL and TSPL printers are asked. CPCL and raster have no status query with a documented answer, so those printers are treated as always ready.

**🔓 Raw TCP printers talk in the clear.** There is no encryption and no sign-in for these, and the app shows a visible "not encrypted" note for them. Use them only on a network you trust.

**🐌 Bluetooth printing is slow on Windows.** Check the stage timings in **History** first: a large `send_ms` points at the Windows spooler. Things worth trying: turn off "Enable bidirectional support" on the queue's Ports tab, or turn on "Print directly to the printer" on its Advanced tab. Even better, set the printer's COM port as the address — the direct path skips the spooler entirely. (These are standard Windows fixes; we have not tested them with PrintNinja.)

<a id="labels"></a>

## 🏷️ Labels

**🖼️ Some label features print as an image, not as printer commands.** Images, custom fonts, non-ASCII text, italic text, bold text outside ESC/POS, and barcodes or QR codes the printer's profile does not list cannot be expressed in the printer's own language. The app prints them as a raster at the printer's DPI instead — the preview and History say why. Text that is too wide now wraps into its box in that raster path; native text is still one line per element.

**📄 Labels are local, but portable.** They are not published to the community. You can export one to a `.pn-label.json` file (name, scene and notes) and import it on another computer.

<a id="phone-and-pc"></a>

## 📱 Phone and PC

**🔐 Encryption trusts the first contact.** Once a phone is paired with a PC, everything between the two — including what you print — is encrypted with a certificate the PC makes, so other devices on the network cannot read your prints. The phone pins the first certificate it sees, so at the moment of pairing you are trusting whoever answers: pair on a network you trust, and if something looks off, unpair and pair again. The technical detail is in [Phone and PC sharing](./architecture/PHONE_AND_PC_SHARING.md).

**🖥️ Only Windows and Linux can be the PC.** They are the platforms with a browser engine to render with; phones and macOS report that they cannot render and are never chosen.

<a id="platforms"></a>

## 💻 Platforms

**🍎 There is no iOS app, and macOS is not supported.** Printing happens on Windows, Linux or Android.

**🌐 The browser version is a preview only.** It lets you try the interface, but printing needs the desktop or Android app.

<a id="real-printers"></a>

## 🧪 Real printers

**🖨️ Nothing has been verified on a real print head yet.** Output has only been checked against simulated printers, so the command-language fixes now in the code — TSPL tuning, ZPL sizing, the CPCL graphics header, the receipt raster width — still need a real head. That is what the [real-printer test checklist](./TEST_CHECKLIST.md) is for; if you have a printer, running it is the most valuable thing you can do for the project.

[⬅️ Back to the README](../README.md)

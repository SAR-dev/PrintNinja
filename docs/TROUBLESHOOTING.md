# 🛠️ Troubleshooting

> **Who this is for:** anyone whose printing is not working the way they expected.
> **What you will know after reading:** the usual cause of each common problem and the quickest fix, with no technical background needed.

Find the problem that sounds like yours. If you are still stuck, see [Still stuck?](#still-stuck) at the bottom. 💪

**Jump to:** [🖨️ Printers](#printers) · [💻 Computers](#computers) · [📱 Phones](#phones) · [🙋 Still stuck?](#still-stuck)

<a id="printers"></a>

## 🖨️ Printers

**🔤 A receipt or label printer prints pages of random characters.**
The printer is being sent a normal document, but it only understands its own command language. Open **Printers**, edit the printer and change **Language** to the one it speaks: **ESC/POS** for most receipt printers, or **ZPL**, **TSPL** or **CPCL** for label printers. If it was already ESC/POS, check the printer's own mode; many label printers ship set to a different one.

**🔌 My USB printer is not in the list.**
- **Windows:** install the printer in Windows first (**Printers & scanners**, then **Add device**). It then appears in PrintNinja under **System**. If it speaks a command language, set **Language** after adding it.
- **Linux:** install CUPS and the printer's driver. For a USB thermal or label printer, create a **raw** CUPS queue, for example `lpadmin -p MyPrinter -m raw -v usb://...`, so the printer receives its commands untouched. It then appears under **System**.
- **Android:** USB printers connect directly; nothing to install.

**🔵 How do I add a Bluetooth printer?**
Pair it in your device's Bluetooth settings, then add it in PrintNinja as **Bluetooth** with the printer's address (its MAC address). On Android, paired printers are listed for you. No driver is needed. On Windows you can also use the COM port Windows gives the printer.

**📵 My Bluetooth printer says "sent" but nothing comes out — or only a couple of characters.**
- **Nothing at all:** the bytes are arriving in a language the printer does not understand. Check **two** settings: the printer's *own* language mode in its menu (most thermal printers ship in a mode other than **ESC/POS**) and the **Language** in PrintNinja — the two must match. For a 58 mm receipt printer the mode is almost always **ESC/POS**.
- **A few characters, then nothing:** the printer's head is slower than the Bluetooth pipe and is dropping the overflow. PrintNinja already spaces the write out in small chunks with a short pause between them; if your model still drops bytes, open the printer, go to **Advanced**, and make it slower still — a smaller **chunk size** and/or a longer **write pause** (leaving a field blank returns it to the built-in default).
- **Everything is there but cut off / squeezed:** the **paper width** in PrintNinja does not match the paper in the printer — set it to the width you loaded (54 mm for a 2-inch roll, 80 mm for a 3-inch roll) and re-test.

**🏷️ A Toshiba B-FP2D says "sent" but prints nothing with ZPL.**
The B-FP2D's own language is **TPCL** (it ships that way); ZPL is only an *emulation* it understands when its command setting is switched to it. While the printer is in TPCL or ESC/POS mode it silently discards every ZPL byte, so PrintNinja reports success and the label stays blank. On the printer, open system mode and set **CMD SETTING** to **Z MODE** (the other choices are TPCL, TPCL1, C Mode for CPCL, ESC/POS and S Mode for SBPL), then restart it. In PrintNinja keep **Language** on **ZPL** and set the paper width to 54 mm or less, which is the widest the B-FP2D head prints. Run **Test Print** first: it sends one line of ZPL text, so if that prints, the mode is right.

**🧩 I want to use my printer's own driver instead.**
In **Printers**, edit the printer and turn on **Print through the OS driver**. The printer must already be installed on your computer under the same name. PrintNinja then does exactly that and never switches between methods on its own.

<a id="computers"></a>

## 💻 Problems on a computer

**🐧 Printing on Linux fails.**
Install CUPS and Chromium or Chrome. Bluetooth printers need neither; pair them in your Bluetooth settings and add them with their address.

**🪟 Printing on Windows fails with "Edge produced no PDF".**
1. If PrintNinja is running **as administrator**, close it and start it again normally. Edge will not print for an administrator process, and the app tells you so.
2. Otherwise open **Settings → Diagnostics** and run **Fix PC printing**. It closes Edge, cleans up leftovers and runs a test.
3. If Edge keeps coming back, the repair offers to download a small separate browser just for printing (about 150 MB, verified, no installer). Your own Edge windows can stay open.

**🚧 A data link is blocked.**
Go to **Settings → Data & network**. You can allow the website there. Blocking of private network addresses is on the same page.

**🌐 I cannot print from the web preview.**
The browser version is a preview only. Printing needs the desktop or Android app.

<a id="phones"></a>

## 📱 Phones

For how pairing works, see [Print from your phone](./PRINT_FROM_PHONE.md).

**🔍 My phone cannot find the PC.**
Check that both are on the same Wi-Fi, that sharing is switched on, and that the code has not run out. Both must be signed in to the same account. You can also type the PC's address by hand (only addresses inside your own network are accepted).

**😴 A phone job says the PC did not answer.**
Make sure the PC is on, awake and on the same Wi-Fi, then refresh. Retry the job from **History**.

**🔄 It says the template is missing or out of date.**
This is on purpose, so you never get a print from an old version. Tap **Sync** on the phone, or sync the template on the PC.

**🤖 Android stops printing after I close the app.**
Open **Settings** in PrintNinja and check that the background service is running. Also check that battery optimization is switched off for PrintNinja in Android's own settings.

<a id="still-stuck"></a>

## 🙋 Still stuck?

- 🐞 Open **Settings → Diagnostics** and choose **Export Diagnostics**, then attach the file when you [report the problem](https://github.com/SAR-dev/PrintNinja/issues). Say what you did, what you expected, and what happened.
- 📖 Not sure what a word means? See the [glossary](./GLOSSARY.md).
- 🗺️ Printer you cannot get working? It may be a [known limitation](./LIMITATIONS.md), which includes what to do instead.

[⬅️ Back to the README](../README.md)

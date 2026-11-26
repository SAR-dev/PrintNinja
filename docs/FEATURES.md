# ✨ Features

> **Who this is for:** anyone who wants to know everything PrintNinja can do.
> **What you will know after reading:** what each part of the app offers, and what the small badges in the top bar mean.

## 🎨 Design

- HTML and CSS editor with a live preview, zoom and fit-to-width
- Ready-made paper sizes: A4, 80 mm and 58 mm rolls, 4×6 labels, and custom sizes
- Barcodes and QR codes made from your data (Code 128/39/93, EAN-13/8, UPC-A, ITF, Codabar, QR), identical in preview and on paper
- Custom fonts, version history with compare and restore, and a notes tab for each template

## 🏷️ Labels

For thermal receipt and label printers:

- Draw the label on a canvas in millimetres: text, barcodes, QR codes, images, lines, rectangles, frames and groups
- Undo, redo, nudge with the arrow keys, and copy and paste
- A model picker for your printer, with eleven models to start (Zebra, Brother, Citizen, Epson, TSC, Toshiba and friends), each with its own paper size and resolution
- The preview goes through the same print path the printer uses, at the printer's own resolution, so the preview and the paper match
- Labels live on this device and are not shared to the community

## 🖨️ Print

- Choose a printer, template, data and number of copies, preview, then print
- Data from sample data, a web link (JSON) or a CSV file; a list of records prints one label or page per record
- Extra options: orientation, fit, margins, page range and black-and-white
- Clear messages when a printer is out of paper, jammed or offline

## 🔌 Printers

- Network, system, USB and Bluetooth printers on Windows, Linux and Android
- Automatic network scan that finds printers and adds them in one tap
- Works with document printers (PDF) and receipt/label languages: ESC/POS, ZPL, TSPL, CPCL and raster
- Checks the printer before sending a job, with time limits so a stuck printer never freezes your queue

## 🤝 Templates and sharing

- **Mine**, **Saved** and **Community** tabs with search and sorting
- Publish a template for others, or save community templates and copy them into your own editable version
- Works offline first; changes sync when the connection returns

## 🕘 History

- Filter by status, source, printer, template and date
- Reprint or retry many jobs at once, export to CSV, and automatic cleanup of old records
- See how long each step of a job took, and who or what sent it

## 🧰 The app itself

- Tray icon, start with your computer, and a background service on Android
- Press `Ctrl/Cmd+K` to search for any page, template, printer, job or setting
- Keyboard shortcuts: press `G`, then `P`, `H`, `D`, `T`, `R`, `A` or `S` to jump between pages
- Phone-friendly layouts, comfortable or compact spacing, your own name and logo
- Built to meet accessibility standard WCAG 2.1 AA

## 🏷️ What the badges in the top bar mean

Some small badges appear in the app's top bar. Each one links to the place where you can turn that feature off.

| Badge | Meaning |
|---|---|
| **API** | The local API (see [Templates and automation](./AUTOMATION.md)) is running on this PC only. |
| **LAN** | Other devices on your network can reach the API. Turn this off if you do not need it. |
| **Sharing** | This PC is available to help phones print. See [Print from your phone](./PRINT_FROM_PHONE.md). |
| **Via PC** | This phone is printing through a paired PC. |
| **Private network open** | Blocking of private network addresses is off, so data links may reach devices on your network. |

[⬅️ Back to the README](../README.md)

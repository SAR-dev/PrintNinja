# 📱 Print from your phone

> **Who this is for:** anyone who wants to print from an Android phone, or let a phone use a PC's printers.
> **What you will know after reading:** when you need to pair a phone with a PC, how to do it, and how to stay in control of it.

You can print straight from an Android phone to a Bluetooth or USB receipt or label printer, with nothing else needed.

For printing normal documents (PDF) from the phone, or for using your PC's printers, you can **pair** your phone with a PC on the same Wi-Fi. Everything stays on your local network.

## 🤝 Pair a phone with a PC

1. On the PC, open **Devices** and switch sharing on. This one switch does everything for you.
2. The PC shows an 8-character code. It runs out after about 90 seconds; ask for a new one if it does.
3. On the phone, open **Connect to PC** and type the code. The phone usually finds the PC by itself under **Nearby PCs**. If not, type the PC's address.
4. Both devices must be signed in to the same account on the same server.

## 🎟️ Let someone borrow your PC without an account

On the PC, choose **Invite guest**. You decide how long the invite lasts (24 hours by default), how many times it can be used, and whether the guest may print or only prepare pages. The guest enters a name, taps **Continue as guest** and types the code. Guests can use your templates but can never read or change them.

## 🔀 Two ways to use a paired PC

- **Shared rendering.** The PC prepares the page and the phone prints it on its own printer. If the PC is off or away, the job fails right away and tells you which PC did not answer. Nothing is silently left waiting. Retry from **History** when the PC is back.
- **Print via PC (Android).** The whole job runs on the PC's printers using the PC's templates. If the phone's copy of a template is out of date, you are asked to **Sync** instead of getting a wrong print. There is no hidden fallback to the phone's printers; switch the option off to print on the phone again.

## 🔒 You stay in control

The PC lists every paired phone. You can rename a phone, turn printing off for it, or remove it. Turning sharing off disconnects all phones.

Everything between your phone and the PC is encrypted, so other devices on the same network cannot read what you print. The one catch: the phone trusts the first certificate it sees when pairing, so pair on a network you trust ([known limitations](./LIMITATIONS.md#phone-and-pc)).

## 🔋 Keep printing after you close the app (Android)

A background service keeps the print queue going even after you swipe the app away. Allow PrintNinja to ignore battery optimization in your Android settings so your prints are not delayed.

## 🛠️ Something not working?

See the **Phones** section of the [troubleshooting guide](./TROUBLESHOOTING.md#phones). For how pairing, tokens and guests work under the hood, see [Phone and PC sharing](./architecture/PHONE_AND_PC_SHARING.md).

[⬅️ Back to the README](../README.md)

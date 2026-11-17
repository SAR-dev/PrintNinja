# 📚 PrintNinja documentation

Pick the guide that matches what you want to do. New here? Start with the [main README](../README.md).

## 🙂 For everyone

- 🎉 [What's new](./CHANGELOG.md): a plain-English list of what changed in each version
- ✨ [Features](./FEATURES.md): everything PrintNinja can do, and what the badges in the top bar mean
- 📱 [Print from your phone](./PRINT_FROM_PHONE.md): pair a phone with a PC, invite guests, and keep printing in the background
- 🛠️ [Troubleshooting](./TROUBLESHOOTING.md): fixes for the most common printer, computer and phone problems
- 📖 [Glossary](./GLOSSARY.md): the plain meaning of every term the app uses
- 🗺️ [Missing features](./MISSING_FEATURES.md): printer support gaps by system and connection type, with workarounds
- 📋 [Test checklist](./TEST_CHECKLIST.md): a real-printer test checklist (not yet run on hardware)

## ⚡ For power users

- 🤖 [Templates and automation](./AUTOMATION.md): template placeholders, the local REST API and deep links
- ⚙️ [Environment settings](./ENV.md): share service settings, including print callbacks
- 🐳 [Self-host the share service](./RELEASE.md#8-share-the-server-build-docker-image-on-ghcr): the ready-made Docker image on GitHub Container Registry, and how to run it

## 👩‍💻 For developers

- 🧭 [Architecture](./ARCHITECTURE.md): the big picture: system map, pipeline, phone to PC, and where a print can fail
  - [Rendering and layout](./architecture/RENDERING_AND_LAYOUT.md): how a design becomes pages and sheets
  - [Printers and transports](./architecture/PRINTERS_AND_TRANSPORTS.md): connection types, printer languages, per-system notes
  - [Queue and history](./architecture/QUEUE_AND_HISTORY.md): the queue, timings, metrics and callbacks
  - [Phone and PC sharing](./architecture/PHONE_AND_PC_SHARING.md): pairing, tokens, guests and Print via PC
- 💻 [Development](./DEVELOPMENT.md): quick start, project layout, tech stack, commands and release
- 🎨 [UI guide](./UI_GUIDE.md): design principles, components and status wording
- ✅ [CI](./CI.md): local checks, hosted workflow and scheduled jobs
- 🚢 [Release](./RELEASE.md) and [Signing](./SIGNING.md): releasing and signing
- 💙 [Contributing](../CONTRIBUTING.md): how to help, including ways that need no code

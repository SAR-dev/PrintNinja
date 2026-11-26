# Screenshots of every page

`pnpm shots` captures each page on each platform, theme, density and language,
so design changes can be reviewed (and before/after compared) without clicking
through the app by hand.

It needs no backend, database or Tauri shell. The app runs in web mode on the
Vite dev server and the e2e fake agent (`e2e/support/fakeAgent`) stands in for
the native side, seeded with sample templates, printers and print history.

## Quick start

```sh
pnpm install
pnpm --filter e2e exec playwright install chromium   # once
pnpm shots
```

Output goes to `screenshots/` (git-ignored):

```
screenshots/
  index.html                         contact sheet, open in a browser
  windows/en-light-comfortable/print.png
  android-phone/en-dark-comfortable/history.png
  ...
```

## Options

| Flag | Values | Default |
|------|--------|---------|
| `--platforms` | `windows`, `windows-narrow-900`, `windows-narrow-1024`, `android-phone`, `android-small`, `android-tablet` | all |
| `--themes` | `light`, `dark` | `light,dark` |
| `--densities` | `comfortable`, `compact` | `comfortable` |
| `--langs` | `en`, `ja` | `en` |
| `--routes` | e.g. `/print,/history` | all pages |
| `--out` | directory | `screenshots` |
| `--jobs` | pages captured in parallel | `4` |
| `--full-page` | `true`, `false` | `true` |
| `--base-url` | use an app that is already running | starts Vite on :1420 |
| `--chromium` | path to a Chromium binary (or env `CHROMIUM_PATH`) | Playwright's own |

Examples:

```sh
pnpm shots --platforms=windows,android-phone --themes=dark
pnpm shots --routes=/print,/history --langs=en,ja
pnpm shots --out=shots/before        # then change code, and:
pnpm shots --out=shots/after
```

## Pages covered

Sign-in, Print, Templates, Designer, Printers, History, Automation, Devices,
Settings (general and profile) and the API explorer. Edit `ROUTES` in
`scripts/screenshots.mjs` to add more.

## Notes

- Android platforms use an Android user agent, so the app shows its phone
  layout and starts from a paired PC (the mandatory pairing gate is skipped).
- Pages are captured with animations off and after the route spinner and
  skeletons have gone, so images are stable.
- The script exits non-zero if a page throws or never finishes loading.
- The narrow desktop widths (900x700, 1024x768) exist to review the
  768-1100px range where the desktop layout does not fit yet.
- A full default matrix (6 platforms x 2 themes x 11 pages = 132 images)
  takes about 5 minutes on a laptop-class machine, mostly Vite compiling
  each page on first visit.
- This is for reviewing design, not a replacement for the e2e layout and
  axe checks in `e2e/tests/`.

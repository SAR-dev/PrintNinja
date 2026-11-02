# Phone and PC sharing

> **Who this is for:** anyone pairing a phone with a PC, using guest invites, enabling Print via PC, or reviewing what the sharing server does and doesn't do.
> **What you will know after reading:** what travels between the phone and the PC, how pairing works and why it is safe, who may call the API, how guests are handled, what Print via PC changes, and exactly what happens when the PC cannot help.

Producing the image or PDF (the "Produce output" step of the
[backend pipeline](../ARCHITECTURE.md#the-backend-pipeline)) is by far the
most expensive part of a print, and a phone does not do it at all. A phone is
always paired with a PC (Windows or Linux) that renders for it, and printing
sends it to the pairing screen until one is paired. A desktop can also borrow
a faster PC, but only to be quicker, because it can render for itself. The
direction is fixed: **a phone asks a PC, never the other way round**, so each
device only shows its own half of the feature. A PC offers itself; a phone
pairs with a PC.

## What travels, and what never does

The phone does everything up to and including laying the pages out on sheets.
It then sends the finished document — plus the paper size, orientation,
printer language and resolution — to the PC. The PC renders it with its own
engine and returns the finished bytes. Rendering has no side effects, so a
repeated request is harmless.

The PC never touches the phone's printers, templates, data sources or
history, and never fetches the print's data itself. Because the document is
the finished page, it does contain that print's real content, which is why
pairing is a deliberate, same-network act. The phone still sends the bytes to
the printer and still writes the history row, which records which device did
the rendering.

## Pairing

The PC shows a one-time 8-character code, valid for 90 seconds
(`PRINTNINJA_PAIRING_TTL_SECS` overrides it), together with its address.
Turning sharing on does everything needed in one step, including bringing up
the local server so phones on the Wi-Fi can reach it. The phone types the
code; the PC answers a discovery hello whenever sharing is on (with a flag
for whether a window is open), and the phone otherwise probes its own /24 for
it, with a typed address as fallback — so a guest invite is discoverable with
no window open. On the same local network there is a third path, mDNS: a PC
with sharing on advertises a `_printninja._tcp` service (TXT carrying
protocol, provider id, port, platform and version), and phones browse that
type to list nearby PCs in the pairing screen — a tap fills in the address,
after which the code-entry flow is the same. The advertisement goes up when
the local server starts and down when sharing turns off.

Both devices must be signed in to the same account on the same server: the
claim carries the phone's account id and service URL, the PC compares them
with its own, and a mismatch (or a signed-out side) is refused before the
code is spent. The verified account is stored on the pair row, and every
later request re-checks it against the PC's current account — signing out or
switching account disables existing pairs, and they must be redone. An
account id is an identifier, not a secret: it never replaces the token or the
one-time code.

The code is only the introduction: claiming it mints a per-device token (the
PC stores just its hash in a `paired_devices` registry), and the window
closes. One active code at a time; five wrong guesses close the window and
only the PC's user can open a new one. A freshly paired PC is tested on the
spot so a bad code shows up immediately. A phone always uses its paired PC, so
there is no "use my PC" switch to turn on. Both devices show who is paired
with whom: the PC lists its phones (with rename and remove), the phone lists
its PCs (with unpair).

Three rules keep this safe:

- **Local network only.** A typed address is checked before anything is
  contacted. Only private addresses, loopback, link-local addresses and local
  or single-word names are accepted. A hostile address therefore cannot make
  a phone send its prints, or the token, to a machine on the internet. Claim
  callers must be private or loopback too.
- **Each phone can be revoked.** Removing a phone on the PC deletes its row,
  and its token is refused from its very next request until it pairs again
  with a new code. (Turning sharing off refuses every phone outright; a
  removal is for when the PC stays shared but one phone should lose access.)
  Re-pairing the same phone replaces its row and keeps the PC's rename; the
  old token dies with the row.
- **The code cannot be guessed.** 40 bits of entropy, a 90-second window,
  five wrong guesses close it, and comparison leaks nothing about how close a
  guess was.

The code is an introduction, not proof of identity, and traffic is plain HTTP
on the local network. Pinned encryption is a planned hardening, not part of
this design.

## Who may use the API

The render routes (`/v1/render`, `/v1/capabilities`) always needed a
paired-device token, and the main routes (`/v1/print`, `/v1/printers`,
`/v1/templates`, `/v1/jobs*`, `/v1/metrics*`, `/v1/openapi.json`) do too:
loopback callers (the PC's own UI and local scripts) pass unchanged, but any
LAN caller must present its per-device Bearer token. Unknown tokens get the
same generic 401 whatever the reason, and repeated failures from one address
get 429. There is no API key and no CORS wildcard — scripts that need the API
run on the PC itself.

Each phone additionally carries a print permission (`can_print`, on by
default, toggled per phone on the PC). Render-only phones keep the render
routes; every main route refuses them with 403. A removal, a sign-out, or an
account switch takes effect on the next request.

## Guests

Owners prove who they are; guests prove they hold a time-boxed invite. The PC
mints invite codes (expiry, optional max uses, print preset); a guest pairs
with the code alone — no account, no window. Guest rows carry
`role = 'guest'` and the invite expiry instead of an account, and both gates
refuse them past expiry with the same generic 401. The account recheck never
applies to guests: there is nothing to compare, so only expiry governs.
Templates stay read-only structurally — the API serves names, never bodies.
The reasoning behind each of these choices is recorded in
[DECISIONS.md](../DECISIONS.md#guest-invites).

## Printing via a PC

Rendering borrows the PC's engine; printing via a PC borrows its printers. On
Android, "Print via PC" reroutes the print dialog from the local pipeline to
`POST /v1/print` on the chosen paired PC: template name plus the sync
identity (`server_id`, `server_revision`), the PC's printer name, data, and
settings. The PC prints with the same pipeline as its own UI — including the
per-printer queue — and the phone polls `GET /v1/jobs/{id}` for the outcome.

While the flag is on, the template picker lists the PC's templates
(`GET /v1/pc-templates`: synced rows only, names plus sync identity, never
bodies) instead of the phone's own rows. The print sends that identity back,
so the version check matches by construction; the phone's history links a
local row only when one shares the id. A PC template with no local copy has
no preview source — the dialog says so and still prints.

Three rules govern it:

- **No fallback.** While the flag is on the phone calls no local transport at
  all. An unreachable PC or a rejected token fails the job with the reason
  ("PC not reachable", "removed on the PC"); printing locally means turning
  the flag off. Retries reuse the caller's `Idempotency-Key`, so a timeout
  never prints twice.
- **The template must match.** The PC resolves by `server_id`, never by name,
  and compares revisions: a missing template is 409 `template_missing`, a
  different revision (or unsynced local edits on the PC's copy) is 409
  `template_stale` with both revisions, and the phone offers Sync instead of
  printing wrongly. Legacy name-only callers keep the old lookup.
- **Remote jobs are bounded.** Inline `data` over ~1 MiB and copies over 100
  are refused before any job row exists; the pipeline itself rejects over-max
  copies and records, so no caller can make a printer eat an unbounded batch.

Both histories tell the story: the PC's job row carries
`requested_by_device_id` (shown as "from \<phone\>" until a revocation clears
it), and the phone writes its own row marked "printed by \<PC\>" with the
revision that ran.

## Choosing a PC and asking it

Each print first asks every paired PC, at the same time, whether it is
available and able to render. The phone prefers a PC of the same operating
family (rendering engines differ subtly between platforms), then the one with
the best capability score, and asks exactly one of them. Probing is
deliberately impatient: opening a connection gets about a second and a half
and the whole probe a few seconds, because on a home network a live PC answers
in milliseconds. A render gets 30 seconds, well inside the PC's own limit.
Fonts uploaded to the app are embedded in the document that is sent, within a
size budget, so the PC renders what the template means rather than what its
own fonts happen to look like.

## When the PC cannot help

What happens depends on whether the device can render for itself.

**A desktop is never worse than printing alone.** Sharing is only allowed to
make a print faster. Any failure — PC off, wrong token, too slow, too busy,
refusing the job, a different protocol version — means the desktop renders
locally and the print goes ahead. Two small memories keep that cheap:

- A PC that answered recently is trusted for a minute, so back-to-back prints
  skip the handshake.
- A PC that just failed is skipped for half a minute, so a PC that is off
  costs one short wait per half minute instead of one per print. When asking
  for a render, only failures that say the PC itself is unwell — unreachable,
  timed out, a server error — count. "Busy", "this document is too big" and
  "the render failed" describe one job, not the PC, and do not mark it down. A
  failed availability check always counts, whether the PC is unreachable,
  refuses the token, has sharing switched off, speaks another protocol
  version or cannot render.

**A phone has no local render to fall back to, so a failure ends the job with
the reason.** The messages name the cause: no PC paired, no paired PC
answered, the PC timed out, refused the document as too large, or is busy. The
phone never reports "cannot rasterize", which would hide the real cause. The
rules differ from a desktop's in three ways:

- Every job asks the PC. The "recently failed" memory is not consulted,
  because a stale skip would fail a job without asking, and the attempt is
  cheap. A recent success (the one-minute memory) is still reused.
- A busy PC is retried instead of abandoned: up to three more tries, waiting
  as long as the PC asks (or five seconds), never more than thirty seconds per
  wait. If it is still busy, the job fails as busy.
- With no PC paired, the job fails at once with a message saying so.

A failed job stays in History and can be retried once the PC is back.

The Settings "Test" button ignores both memories and shows the PC's state
right now, and clears them when it finds the PC.

## The PC's own prints come first

A PC should never get slower because a phone is borrowing it. While the PC is
rendering one of its own prints, requests from phones are answered "busy,
retry shortly". A desktop consumer then renders locally; a phone waits and
retries (above). Beyond that, the PC renders at most two borrowed documents at
once, caps the size of a document (and, above that, of the whole request, so
an oversized upload is cut off rather than buffered), and gives up on a render
that takes too long. Each limit ends with a desktop printing locally, or a
phone failing the job with the reason.

## What it does not do

A PC cannot print on a phone's printer, the server in the cloud is not
involved (it has no rendering engine), and accounts are not shared. Only
Windows and Linux desktops can act as the PC for now (they are the ones with a
browser engine to render with); phones and macOS report that they cannot
render and are never chosen. Discovery is by typed pairing code (backed by a
/24 hello probe, with a typed address as fallback); finding PCs automatically
on the network, and encrypting the traffic with a pinned certificate, are
future work.

The design decisions behind every rule above are recorded in
[DECISIONS.md](../DECISIONS.md#shared-rendering-phones-pcs).

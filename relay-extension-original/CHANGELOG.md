# Changelog

All notable changes to the Relay extension are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.4.4] — 2026-09-03

Builds on the Drive share tool: native-host attachment conversion (HTML → PDF /
image) with a mailer-style toolbar, a redesigned panel with live status, and
input validation.

### Added

- **Native-host detection** (`script/drive/driveNativeHost.js`, isolated world),
  mirroring `srv.js`. `PING`s the Bin4ry pdf-bridge via the background for a
  tri-state status (up / absent / stale) and, crucially, receives the
  background's **`NATIVE_HOST_STATUS` pushes** so the status updates live the
  moment the host connects/disconnects — no polling. Console: `driveHostStatus()`,
  `driveHostConvert(request)`.
- **Attachment / conversion toolbar** in the panel (mimics the mailer's
  `html → [format] → Customize · PDF Engine · Clear`). Formats: pdf / jpeg / png /
  webp / tiff / heic / bmp. **Customize** popover exposes the common per-format
  settings (file name, quality, DPI, page format, landscape, watermark; resize
  for images); **PDF Engine** picks the engine hint (libreoffice / puppeteer).
- **HTML → file conversion on upload** — a new `script/drive/attachmentModel.js`
  (ported from `mailer/js/attachmentModals/index.js`) builds the exact
  `CONVERT_PATH` request; `driveUpload({ convert })` runs it through the native
  host, inflates the gzipped result, and uploads the converted file (e.g. a PDF)
  instead of the source, falling back to a plain upload if the host is down.
  `{tags}` in the conversion file name / watermark resolve per recipient.
- **Top status bar** — a live status line under the header mirrors the latest log
  message (per-chunk progress, conversion, errors) with a spinner and an
  animated progress bar while running.
- **Email validation + formatting** — live per-entry validation with a green /
  orange field state and a valid/invalid hint; on blur it trims, de-duplicates,
  and one-per-lines the list. Runs are blocked on any invalid address.
- **Field completeness cues** — any populated text field turns green; **Content /
  HTML is now required** and the default **file name is `sample-file-{orderno}`**.

### Changed

- **Panel redesigned** — grouped, labeled sections (Recipients / Message / File /
  Attachment / Options), a bordered attachment card, and subtle animations
  (panel fade-in, pulsing status dot, pop-in popovers).
- **Manifest** — Drive isolated bundle now also loads `faker.js`,
  `tagProcessor.js`, and `driveNativeHost.js`; the MAIN bundle adds
  `attachmentModel.js`. Background now broadcasts `NATIVE_HOST_STATUS` to
  `drive.google.com` tabs. Extension version **4.0.3**.

### Fixed

- **Attachment card is disabled/blurred** when the native host isn't detected,
  and conversion is skipped (plain upload) rather than hanging.
- **Converted uploads no longer stick on "uploading"** — `driveUpload` returns
  the *actual* uploaded file name (e.g. `…​.pdf`) so the wait/open steps match the
  real toast instead of the pre-conversion `.txt` name.
- **Panel can't drift off-screen** — restored size/position is clamped to the
  viewport and the header stays reachable while dragging.

## [0.4.3] — 2026-09-03

Adds a self-contained **Google Drive share automation** — a MAIN-world tool on
`drive.google.com` that uploads a file, opens it, shares it with one or more
recipients (role, note, non-Google confirm), and reports the result — driven by
an on-page control panel and gated to authenticated Relay accounts.

### Added

- **Drive upload + share engine** (`script/drive/uploadFile.js`, MAIN world).
  Console/API helpers: `driveUpload`, `driveWaitUploaded`, `driveOpenFile`,
  `driveClickShare`, `driveAddPerson`, and the full chain `driveUploadAndShare`.
  - **Upload without the file picker** — injects the file into Drive's hidden
    `input[type=file]` (patches `click`/`showPicker` so the native chooser never
    opens).
  - **Slow-connection safe** — `driveWaitUploaded` waits for the upload toast to
    reach its finished state (up to a configurable `uploadTimeout`, default
    120 s), failing fast if Drive shows a Retry.
  - **Open via the upload toast**, then click **Share**, verifying the dialog
    actually opened (re-clicks if Drive drops the first click).
  - **Add recipient(s)** into the Share people-combobox (in its same-origin
    iframe), committing via `execCommand('insertText')` + Enter, with an optional
    **message** note and **role** selection (Viewer / Commenter / Editor).
  - **Chunk-based sharing.** `driveAddPerson` / `driveUploadAndShare` accept an
    `emails[]` array — one uploaded file is shared with a whole chunk of people
    in a single Send. The panel has a **Recipients / file (chunk)** field
    (default 3): the recipient list is split into chunks, each chunk uploads one
    file and invites everyone in it together, with per-chunk progress in the log.
  - **Non-Google recipients** — auto-confirms the "Share anyway" dialog.
  - **Verify + close** — confirms the "Access updated" toast and closes the
    dialog (both optional).
- **On-page control panel** (auto-shown, draggable, resizable). Fields for
  emails (multiple, comma/newline), role, message, file name/content, verify,
  close-after, and upload timeout — all persisted in `localStorage`. A live
  status log, a **Stop** control for multi-recipient runs (`driveStop()`), a
  **minimize** button, and a **close → floating launcher** that remembers its
  dragged position and reopens the panel there.
- **Tag support** — a **＋ Tag** picker on every text field inserts
  `{placeholder}` tokens; on run they resolve per recipient through the real
  `tagProcessor.js` + faker engine.
- **Auth gate** (`script/drive/driveAuthBridge.js`, isolated world). Mirrors
  `srv.js`: every action verifies with the background (`GET_AUTH_STATUS`) that
  the account is authenticated — `v === true`, a fresh (≤60 s) token, and
  `verification === sha256(RELAY_TOKEN + runtime id)` — before running. A 60 s
  **watchdog** hard-locks the panel and all actions if authorization is ever
  lost (reload required after re-authenticating).
- **Full debug tracing** — tagged, timestamped console lines (`[drive:<tag>]
  +Ns`) for every step, with `driveDebug()` diagnostics and `driveDebugOn/Off()`
  toggles; warnings/errors always print.

### Changed

- **Manifest** registers two Drive content scripts: an isolated-world bundle
  (`relayConfig.js` + `faker.js` + `tagProcessor.js` + `driveAuthBridge.js`) and
  the MAIN-world `uploadFile.js`. Bumped extension version to **4.0.3**.

### Fixed

- **Drive page no longer breaks** with the extension enabled. `faker.js` was
  loading in the MAIN world, where its top-level global `var`s clobbered Drive's
  own minified globals and crashed the page mid-load. faker + `tagProcessor.js`
  now run in the isolated world, and tag resolution happens over a postMessage
  bridge, leaving Drive's page globals untouched.
- **Panel close/minimize** — the `×` now actually hides the panel (an ID-level
  `display:flex` rule was overriding the default `[hidden]` style); added a
  `[hidden]` override plus a dedicated minimize button and a robust,
  inline-styled floating launcher.

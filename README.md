# VoidZone Uploader (DoodStream / EarnVid)

Internal desktop tool (Electron, Windows) to bulk-upload anime episode video
files to DoodStream and EarnVid, with a live progress list and one-click
"copy all links" to paste straight into voidzone's admin panel bulk-link flow.

This tool is standalone — it is NOT part of the voidzone website build and
does not affect `npm run build` / Cloudflare Pages deploy of the main site.

## Install

```
cd tools/doodstream-uploader
npm install
```

## Run in dev mode

```
npm run dev
```

(or `npm start`)

## First run — API keys

On first launch, if no keys are saved yet, a "API Keys" settings dialog opens
automatically. You can also open it anytime via the "API Keys" button in the
top-right corner. Paste your:

- **DoodStream API key** — from https://doodstream.com/settings
- **EarnVid API key** — from your EarnVid/earnvids account dashboard

Keys are saved locally via `electron-store` as a JSON file in your Windows
user data directory (e.g.
`%APPDATA%\doodstream-uploader\config.json`) — never hardcoded, never
committed to this repo.

## Using it

1. Click "Choose Folder" and pick a folder containing episode video files
   (`.mp4`, `.mkv`, `.avi`, `.mov`, `.webm`). Files are listed sorted by
   filename (natural/numeric order), which matters for episode ordering.
2. Tick DoodStream and/or EarnVid as upload targets.
3. Click "Start Upload". Each file shows per-provider status
   (queued / uploading / done / failed), a live progress bar, and the
   resulting embed URL once done.
4. A failed upload shows its error inline with a "Retry" button — it never
   silently disappears from the list.
5. Click "Copy All Links" to copy one URL per line, in filename order, for
   the first active provider — ready to paste into voidzone's admin panel
   bulk multi-link-per-line episode creation flow.

## Build a distributable Windows installer

```
npm run build
```

Output goes to `tools/doodstream-uploader/dist/` (an NSIS `.exe` installer),
via `electron-builder`. This lets the owner run the app without a dev
environment installed.

## API notes

- **DoodStream**: documented HTTP API at https://doodstream.com/api-docs.
  Two-step upload: `GET https://doodapi.co/api/upload/server?key=API_KEY`
  returns an upload server URL, then a `multipart/form-data` `POST` of the
  file (plus `api_key` field) to that URL returns the file's `filecode`.
  Embed URL: `https://doodstream.com/e/{filecode}` (matches the convention
  already used in `src/lib/supabase.ts`'s `getDoodStreamEmbedUrl`).
- **EarnVid**: documented HTTP API at https://earnvidsapi.com/api.html,
  following the same two-step flow (`GET .../api/upload/server?key=...` then
  `POST` multipart file with a `key` field). Embed URL:
  `https://xvs.tt/{filecode}.html` (matches `getEarnVidEmbedUrl` in
  `src/lib/supabase.ts`).
- Upload progress for large files (200MB-1GB+ episode files) is reported via
  axios's `onUploadProgress` callback on the multipart POST, streamed live to
  the UI per file per provider.
- Both providers' upload endpoints are a single multipart POST (no
  chunked/resumable upload documented) — progress reporting is done via
  byte-count tracking on that single request, not true resumability. If a
  large upload fails partway, use the Retry button to re-upload the whole
  file.

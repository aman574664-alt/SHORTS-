# Shorts Scheduler — development prototype

Launch release/ShortsScheduler-win32-x64/ShortsScheduler.exe, or run npm start.
Choose a local or synced folder. Wait 30 seconds after copying files. Select audience, edit metadata and future UTC time, then resume the queue. Daily slot settings use Asia/Kolkata by default. Pausing retains progress. Cancel affects the local simulation only.

This is a MOCK-ONLY prototype, not a working YouTube uploader. No Google authorization, real resumable transport, remote reconciliation, thumbnail support, processing polling or live publication has been implemented. No account credentials are collected. Do not depend on it to publish videos. Six slots reserve future times; they do not guarantee six daily publications. Stability detection cannot guarantee a paused sync has finished.

Queue data resides in Electron's Windows user-data directory outside the repository. Keep source videos in place; originals are never changed. npm test runs four automated mock tests. npm run build produces a Windows executable folder; keep that folder together. The executable is unsigned.

For the future live integration: create a Google Cloud project, enable YouTube Data API v3, configure OAuth consent and a Desktop app client. Never supply your Google password to this application. Real uploads and public scheduling require separate explicit approval before testing. Once actually uploaded and scheduled on YouTube, a PC may be off at publication; it must be awake and online during upload.

Official references checked 2026-10-31:
- https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- https://developers.google.com/youtube/v3/getting-started
- https://support.google.com/youtube/answer/15424877
Current documentation describes 100 default upload calls/day with a separate upload bucket; verify the project's actual console quota. Current insert documentation says unverified API projects are not restricted to private viewing, unlike older guidance. OAuth verification is a separate concern. Square or vertical videos up to three minutes qualify for Shorts under current guidance. A past publishAt can publish immediately, so a future live implementation must fail closed on missed slots.

GitHub connector account: aman574664-alt. No repository-creation tool or gh CLI was available. Create an empty private repository called shorts-scheduler on GitHub, then from this directory run:
 git remote add origin https://github.com/aman574664-alt/shorts-scheduler.git
 git push -u origin main
Authentication may be required. Never add credentials to source control.

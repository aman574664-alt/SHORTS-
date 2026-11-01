# Shorts Studio — local Windows YouTube uploader

A minimal poster-style desktop app for one YouTube channel and one watched folder. This version contains the real OAuth, upload and scheduling paths. Automated checks use mocked YouTube responses. An owner-authorized live test on 1 November 2026 verified Google sign-in, 10 processed uploads and 10 YouTube-accepted future public schedules spaced one minute apart. A real quota/channel limit blocked three further attempts; those remain stopped for manual retry. Actual public publication and account restrictions are controlled by YouTube.

## Open the app

On the developer's computer: double-click **Shorts Scheduler** on the desktop, or open `release/ShortsScheduler/ShortsScheduler.exe`.

Keep the entire `ShortsScheduler` folder together. It is a portable Windows x64 app, not an installer. The executable is unsigned. Python is not required.

From source: install Node.js 22 or later, run `npm ci`, then `npm start`. To make a portable Windows app, run `npm run build`; the output is `release/ShortsScheduler`. The build uses the installed Electron runtime and includes Luxon. No paid hosting or paid AI service is used.

## Connect your own channel

YouTube requires the operator of a personal app to provide a Google OAuth Desktop client. The repository cannot include shared channel credentials. The **Connect YouTube** screen links to each setup page:

1. Create/select a free project in Google Cloud and enable **YouTube Data API v3**.
2. Configure the Google Auth consent screen. For an External app in Testing, add your own Google account under **Audience → Test users**.
3. Under **Clients**, create an OAuth client of type **Desktop app**. Download its JSON file. Keep this original download private.
4. Click **Choose Google app JSON** in Shorts Studio, then **Connect YouTube**. Complete Google sign-in in your system browser and select the correct channel. Never enter a Google password into this app.
5. Verify the channel name shown in the app. Click **Enable real uploads** and approve the native confirmation when you are ready.

Google's `youtube.force-ssl` scope lets the app read channel uploads, upload videos, manage metadata and schedules, and reconcile uncertain results. Google may describe broader capabilities in its consent screen; this application never invokes deletion APIs. OAuth uses a random loopback port, a state check and PKCE. Credentials, refresh tokens and resumable-session addresses are encrypted with Electron safeStorage (Windows account protection) outside the repository. Disconnect clears the local token; revoke the app in your Google account to revoke server access. A Testing app's refresh token may expire after seven days. OAuth consent verification is separate from YouTube API or channel eligibility checks.

## Add and publish videos

1. Choose a folder containing finished MP4, MOV, WEBM, MKV, M4V or AVI videos. External drives and locally synced Google Drive folders work when they are available to Windows.
2. You can also use **Add videos** to select individual files without moving them. After 30 seconds of unchanged size and modification time, videos appear as **Needs review**. Existing files are also discovered. For a slow copy/export that might pause, use a `.part` ending until fully complete, then rename to the real video extension. Stability checks cannot prove that a remote sync has finished.
3. Click a video to edit title, description, audience, thumbnail and posting time. All posting-time inputs use the timezone displayed next to them, initially **Asia/Kolkata**.
4. Confirm that you reviewed the finished video and its audience. Square/vertical videos up to three minutes qualify as Shorts; landscape videos can still be uploaded as regular YouTube videos. The app does not transcode your files.
5. Choose **Keep private** or **Schedule public release**. Save details and approve the video. Scheduling asks for explicit public-release confirmation.
6. Click **Resume queue**. Uploads are initially private. The app polls processing and only then submits the approved future `publishAt`. A past or too-close time is blocked rather than published immediately.
7. Keep the computer awake, the app open and the internet connected until the video is **Scheduled**. YouTube can publish an accepted schedule while your PC is off. Closing the app stops local uploads; saved sessions resume after reopening.

Six daily slots are configurable in **Daily schedule**. New videos get the next unoccupied slot at least an hour ahead. The app does not manufacture six videos or guarantee six posts if content is missing, not reviewed, restricted, or late. Already assigned videos keep their times when settings change. The editor can change an uploaded video's future schedule with confirmation. For other uploaded metadata edits, use YouTube Studio.

## Batch release (including a one-minute test)

After connecting, adding videos and enabling uploads, click **Schedule pending videos**. Choose the audience for all pending videos, set the minutes between public posts, review the batch, then approve. Resume the queue.

Batch videos upload privately first. Only when every non-cancelled batch video has finished processing does the app reserve public timestamps, beginning at least five minutes in the future. A one-minute interval means publication timestamps differ by 60 seconds; it does not mean large files upload in one minute. The plan, consent and timestamps survive restarts. A failed or uncertain item holds the batch until resolved. YouTube controls the actual processing and public release timing.

## Controls and recovery

- **Pause queue** stops new video chunks after the current network request; it does not cancel schedules already accepted by YouTube. Processing polling continues for uploaded videos.
- **Pause video** keeps that video's session. Approve it again to resume.
- **Cancel video** stops that local item. For a known uploaded video, it removes the future schedule and makes the video private. Neither original files nor YouTube videos are deleted.
- **Retry safely** queries the saved upload session before sending bytes. Server-confirmed offsets determine where to resume, including after restart.
- **Reconcile with YouTube** searches the channel's most recent 2,000 uploads for the video's unique content-hash tag. An uncertain result stays blocked if no match is found; absence is not proof that a delayed upload failed. Check Studio. This version intentionally offers no force-upload-another-copy button for uncertain results.
- Missing files/drives, changed content, expired authorization, quota limits, processing failures and missed slots show an explanation on the video or folder banner.
- Global transient errors retry with exponential delay, up to seven automatic retries, then require attention. Quota and permanent errors require manual retry. The app does not claim to know your project's remaining quota.

Duplicate protection uses a full SHA-256 content hash, so renaming or copying identical files does not create another item. Byte changes create a new identity. A persistent library is bound to one channel. Do not delete its history to resolve uncertainty.

Thumbnails: choose a JPG or PNG up to 2 MB before upload. The app attempts `thumbnails.set` once. Shorts thumbnail support depends on YouTube's channel rollout and API behavior. A rejection is shown without failing the uploaded video; add the thumbnail in Studio if supported. Original files are always left in place.

## Local data and privacy

Library: `%APPDATA%/Shorts Scheduler/library-v2.json` (actual Electron user-data path can vary with development launch names). It includes paths, metadata, hashes, statuses and known video IDs. An atomic replace and previous-file backup protect queue writes. Secrets are stored separately in encrypted `credentials.bin`, never returned to the renderer. Do not publish the local user-data folder. There is no export, analytics or external media loading. API errors are converted to short explanations; raw API responses, OAuth codes, tokens and session URLs are not logged. The source folder's downloaded Google JSON is your responsibility; import never moves or deletes it.

The earlier Python uploader is retained under `YouTube_Auto_Uploader_Windows` for reference only. The Windows app now implements its folder stability, OAuth, SQLite-history intent and retry behavior using Electron/Node, with persistent JSON and content identities. Do not run the old watcher alongside this app: their histories are separate. The old demo library is also separate and never treated as real upload history.

## Verification

`npm test` covers persistence and backup recovery, stable copying, renamed/copied duplicates, timezone slots, missed-slot blocking, review requirements, same-session restart recovery, server offsets, uncertain outcomes, private processing, accepted scheduling, source mutation, quotas, and OAuth config validation.

`node_modules/electron/dist/electron.exe scripts/smoke.cjs` opens a separate temporary test library, exercises real renderer controls, checks native encryption and captures screenshots under `output/`. It never connects Google or uploads. Close other development app instances first if your OS prevents a second Electron app instance.

Live Google authorization, upload, thumbnail acceptance and public publication still require the owner's account and an explicitly approved real test. Local mocked tests cannot prove those account-specific behaviors. Automatic startup is available on the schedule screen; its registry setting was not enabled during development.

## Official requirements checked 1 November 2026

- [videos.insert](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert): current documentation describes a separate default quota of 100 upload calls/day, costing 1 in that bucket, and accepts video or octet-stream up to 256 GB. Other method quotas and channel limits also apply; confirm your project's actual limits in Cloud Console. Current insert documentation states unverified API projects are not restricted to private mode; older documentation said otherwise, so do not rely on old guidance. Google account, project, consent, channel and content restrictions can still reject an operation.
- [Video status and publishAt](https://developers.google.com/youtube/data/reference/rest/v3/videos): scheduling uses a private, never-published video with a future timestamp. A past timestamp can publish immediately; this app blocks it.
- [Resumable upload protocol](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol): recover via session status, 308 responses and server byte ranges. Expired sessions require uncertainty review here.
- [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app): system-browser authorization, loopback callback, PKCE and offline token refresh.
- [Three-minute Shorts](https://support.google.com/youtube/answer/15424877): square/vertical up to three minutes; YouTube content restrictions can prevent distribution.
- [Thumbnail support](https://support.google.com/youtube/answer/72431) and [thumbnail API](https://developers.google.com/youtube/data/reference/rest/v3/thumbnails/set): channel verification and current Shorts support matter. Studio functionality does not guarantee API support.

This application uses YouTube API Services. See [YouTube Terms](https://www.youtube.com/t/terms) and [Google Privacy Policy](https://policies.google.com/privacy).

Local connection diagnostic: `scripts/connect-channel.cjs` uses the same encrypted Windows credential store and opens the system browser for user-completed OAuth. It never prints tokens. The optional `--login-hint` can point sign-in at an account already listed as a Google test user. `scripts/prepare-batch.cjs` requires explicit folder, audience, and public one-minute approval flags and only prepares the persistent queue; the normal app performs transfers. Do not run these helpers while the desktop app is writing its library.

Read-only live verification: `scripts/check-live.cjs` reads uploaded video processing, privacy, audience and schedule status directly from YouTube. It never prints tokens or session URLs.

Editing an unuploaded batch item removes it from its previous batch plan. Save and approve its new visibility explicitly; choosing Private cannot inherit an earlier batch release plan.

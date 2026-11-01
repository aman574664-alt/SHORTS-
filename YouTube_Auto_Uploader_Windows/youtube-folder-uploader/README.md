# YouTube folder auto-uploader (Windows)

Automatically upload new videos from a watched folder to a YouTube channel using OAuth 2.0.
This is a personal, local Windows tool. It does not use an API key for uploads.

## Requirements

- Windows 10/11, Python 3.10 or newer, internet access.
- A YouTube channel on the Google account you authorize.
- Google Cloud project with **YouTube Data API v3** enabled.
- An OAuth 2.0 **Desktop app** client JSON file.

## Set up Google Cloud

1. Open https://console.cloud.google.com/ and create/select a project.
2. Enable https://console.cloud.google.com/apis/library/youtube.googleapis.com
3. Configure the OAuth consent screen in https://console.cloud.google.com/auth/overview
4. For an External app in Testing status, add your account to **Test users**.
5. Add scope `https://www.googleapis.com/auth/youtube.upload` under Data Access.
6. Create an OAuth client under Clients of type **Desktop app**.
7. Download its JSON; rename to `client_secret.json`; place next to `uploader.py`.

IMPORTANT: Never share `client_secret.json` or `token.json`. The latter can grant access to your account.

## Install & run

1. Install Python 3.10+ from https://www.python.org/downloads/windows/ and select **Add Python to PATH** (or use the `py` launcher).
2. Extract this ZIP to any folder, e.g., `C:\YouTubeUploader`.
3. Double-click `setup_windows.bat` to install required libraries.
4. Put `client_secret.json` in the extracted project folder.
5. Double-click `authorize_once.bat`. A Google sign-in window opens: select the correct YouTube channel and authorize.
6. Double-click `start_uploader.bat` and leave the window running.
7. Put a short test video into `incoming`. It uploads automatically after 60 seconds without changes, checked every 10 seconds.
8. Check your **Private** videos in YouTube Studio: https://studio.youtube.com/

Previously existing eligible files in the watched folder are also uploaded on first start, unless they are already in the local history database.

## Configuration

Edit `config.json`:

```json
{
  "watch_folder": "incoming",
  "privacy_status": "private",
  "description": "Uploaded automatically from my Windows PC.",
  "stable_seconds": 60,
  "scan_every_seconds": 10
}
```

- `watch_folder` can be `incoming` or an **absolute Windows path** such as `C:\\Users\\YourName\\Videos\\ToUpload` (double backslashes are required in JSON).
- `privacy_status`: `private` (safest), `unlisted`, `public`. **Choose public only when comfortable with automatic publishing** and your project's/API account restrictions permit it.
- The video's **filename becomes its title** (underscores are replaced with spaces); its description comes from `config.json`.
- Supported extensions: MP4, MOV, MKV, M4V, AVI, WEBM. YouTube must also accept the file's actual codec/content.
- Only immediate files in the watch folder are scanned, not files inside subfolders.
- Videos stay on disk after upload. A successful upload's ID is recorded in `upload_history.sqlite3`, so it will not be uploaded again when the watcher restarts.

## Uploading safely

The program checks for unchanged file size and modification timestamp for at least `stable_seconds` before uploading. **Some video exports might pause longer than this while still being written**. For a stronger guarantee, first save/copy to a filename ending in `.part`, then rename to `.mp4` only when the file is complete.

The program handles transient network errors with retries inside YouTube's **resumable** upload session. If a request ends with an ambiguous failure, the file is marked `needs_review` and is NOT restarted automatically. This prevents accidental duplicate uploads if YouTube actually received the video before the program lost the response.

After checking YouTube Studio and confirming the video really did NOT upload, manually clear its status with:

```
py -3 uploader.py --retry "incoming\my video.mp4"
```

Type `RETRY` when prompted, then restart the watcher. `--retry` cannot clear successfully uploaded records. If the video DID upload, leave it in history to avoid duplicates.

To see upload history: double-click `history.bat`.

Do **not** delete `upload_history.sqlite3` if you want to preserve duplicate protection. Do not edit videos in place after uploading unless you intend for a modified file to be seen as a new upload.

## Start automatically with Windows

1. Run `authorize_once.bat` successfully first.
2. Open Task Scheduler → Create Task → General → select **Run only when user is logged on**.
3. Triggers → New → **At log on**.
4. Actions → New → **Start a program**:
   - Program/script: `C:\Windows\py.exe` (only if your `py` launcher is installed there; otherwise locate `py.exe` by running `where py`).
   - Add arguments: `-3 "C:\YouTubeUploader\uploader.py"` (replace with your real path).
   - Start in: `C:\YouTubeUploader` (replace with your real path).
5. Save the task, then test it. Keep your PC powered on and signed in for uploads to happen.

**Simpler alternative:** press Win+R, type `shell:startup`, and add a shortcut to `start_uploader.bat` there. The window opens when you log in.

## OAuth notes

- OAuth consent on an External app in **Testing** mode usually grants a refresh token that expires in seven days. If this happens, run `authorize_once.bat` again; the uploader requires a browser sign-in. See: https://developers.google.com/identity/protocols/oauth2
- For long-lived use, review Google's Publishing Status and verification requirements. Publishing to Production and verifying OAuth is distinct from any YouTube API compliance audit requirements.
- Using a new Google Cloud project, check current YouTube rules and account restrictions before expecting public/unlisted videos. See https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- Default quota for `videos.insert` is 100 calls per day, subject to the limits shown in Google Cloud: https://developers.google.com/youtube/data/getting-started

## Troubleshooting

- **`access_denied` / `403` on OAuth:** Add your account under Test users; confirm the API is enabled and scope correct.
- **`invalid_grant`:** Refresh token expired or revoked. Run `authorize_once.bat` again.
- **`quotaExceeded`:** Stop and check your daily Google Cloud quota. The uploader marks the failed attempt for manual review; don't clear it until you are ready.
- **Different channel:** Remove `token.json` only after stopping the watcher, then run `authorize_once.bat` and select the desired Google account/channel. Keep your history separate for each channel to avoid confusing records.
- **Duplicate videos:** Do not run multiple copies; this program locks a single instance. File identities are based on path, size, and mtime, not full content. Identical content with a different filename can upload again.
- **Upload doesn't happen:** The file needs a supported extension, nonzero size, and a full stability interval; check `uploader.log` and `history.bat`.
- **PC off/sleep:** No uploads occur until the PC resumes and the watcher is running.

## Official docs

- YouTube videos.insert: https://developers.google.com/youtube/data/reference/rest/v3/videos/insert
- OAuth installed app flow: https://developers.google.com/youtube/data/guides/auth/installed-apps
- Resumable uploads: https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol

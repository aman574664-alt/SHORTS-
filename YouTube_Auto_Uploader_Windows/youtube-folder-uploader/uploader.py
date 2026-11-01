"""Windows-friendly YouTube folder uploader (Python 3.10+).

Uploads new, stable video files with OAuth 2.0, preserves a local SQLite history,
and avoids automatically repeating uploads whose final outcome is uncertain.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import sqlite3
import sys
import time

ROOT = Path(__file__).resolve().parent
SETTINGS = ROOT / "config.json"
CLIENT_SECRET = ROOT / "client_secret.json"
TOKEN_FILE = ROOT / "token.json"
DATABASE = ROOT / "upload_history.sqlite3"
LOG_FILE = ROOT / "uploader.log"
LOCK_FILE = ROOT / ".uploader.lock"
SCOPE = ["https://www.googleapis.com/auth/youtube.upload"]
VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm"}


def configure_logging():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_FILE, encoding="utf-8")],
    )


def load_settings():
    if not SETTINGS.exists():
        raise FileNotFoundError("Missing config.json in the project folder.")
    options = json.loads(SETTINGS.read_text(encoding="utf-8"))
    raw_folder = Path(options.get("watch_folder", "incoming")).expanduser()
    folder = raw_folder if raw_folder.is_absolute() else ROOT / raw_folder
    privacy = options.get("privacy_status", "private")
    if privacy not in ("private", "unlisted", "public"):
        raise ValueError("privacy_status must be private, unlisted, or public")
    stable = int(options.get("stable_seconds", 60))
    interval = int(options.get("scan_every_seconds", 10))
    if stable < 10 or interval < 1:
        raise ValueError("stable_seconds must be >= 10 and scan_every_seconds >= 1")
    description = str(options.get("description", ""))
    if len(description) > 5000:
        raise ValueError("Description cannot exceed 5000 characters")
    folder.mkdir(parents=True, exist_ok=True)
    return {
        "watch_folder": folder,
        "privacy_status": privacy,
        "stable_seconds": stable,
        "scan_every_seconds": interval,
        "description": description,
    }


def video_fingerprint(path, stat):
    # File-version identity: same file + size + modification time = same upload.
    # This is not a full content hash; identical copies with new names are distinct.
    text = f"{str(path.resolve()).casefold()}|{stat.st_size}|{stat.st_mtime_ns}"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def display_title(path):
    return (path.stem.replace("_", " ").strip() or "Untitled video")[:100]


def open_database():
    db = sqlite3.connect(DATABASE, timeout=30)
    db.execute("""
        CREATE TABLE IF NOT EXISTS uploads (
            fingerprint TEXT PRIMARY KEY,
            file_path TEXT NOT NULL,
            status TEXT NOT NULL,
            video_id TEXT,
            updated_utc TEXT NOT NULL,
            details TEXT
        )
    """)
    db.commit()
    return db


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def mark_status(db, fingerprint, path, status, video_id=None, details=None):
    db.execute(
        """INSERT INTO uploads
           (fingerprint, file_path, status, video_id, updated_utc, details)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(fingerprint) DO UPDATE SET
             status=excluded.status,
             video_id=excluded.video_id,
             updated_utc=excluded.updated_utc,
             details=excluded.details""",
        (fingerprint, str(path), status, video_id, utc_now(), details),
    )
    db.commit()


def authorize():
    # Import on demand so --history and local tests work without API dependencies.
    from google.auth.exceptions import RefreshError
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CLIENT_SECRET.exists():
        raise FileNotFoundError(
            "Missing client_secret.json. Download your OAuth Desktop-app JSON "
            "from Google Cloud, and rename it client_secret.json."
        )

    credentials = None
    if TOKEN_FILE.exists():
        credentials = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPE)

    if credentials and credentials.valid:
        return credentials

    if credentials and credentials.refresh_token:
        try:
            credentials.refresh(Request())
        except RefreshError:
            logging.warning("Your saved Google authorization expired/revoked. Reauthorization required.")
            credentials = None

    if not credentials or not credentials.valid:
        logging.info("Opening your browser to authorize access to your YouTube channel...")
        flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET), SCOPE)
        credentials = flow.run_local_server(port=0)

    TOKEN_FILE.write_text(credentials.to_json(), encoding="utf-8")
    return credentials


def youtube_service():
    from googleapiclient.discovery import build

    return build("youtube", "v3", credentials=authorize(), cache_discovery=False)


def upload_video(service, file_path, options):
    from googleapiclient.http import MediaFileUpload

    media = MediaFileUpload(
        str(file_path),
        chunksize=8 * 1024 * 1024,
        resumable=True,
    )
    request = service.videos().insert(
        part="snippet,status",
        body={
            "snippet": {
                "title": display_title(file_path),
                "description": options["description"],
                "categoryId": "22",  # People & Blogs
            },
            "status": {"privacyStatus": options["privacy_status"]},
        },
        media_body=media,
    )

    result = None
    last_reported = -1
    while result is None:
        # Client library retries transient HTTP/transport failures using backoff
        # within this same resumable upload session.
        progress, result = request.next_chunk(num_retries=4)
        if progress:
            percentage = int(progress.progress() * 100)
            if percentage // 10 > last_reported // 10:
                logging.info("%s: %s%% uploaded", file_path.name, percentage)
                last_reported = percentage

    if not isinstance(result, dict) or not result.get("id"):
        raise RuntimeError("Upload returned no YouTube video ID; check YouTube Studio.")
    return result["id"]


def history(db):
    records = db.execute(
        "SELECT file_path, status, video_id, updated_utc, details "
        "FROM uploads ORDER BY updated_utc DESC LIMIT 50"
    ).fetchall()
    if not records:
        print("No uploads recorded yet.")
        return
    for name, status, video_id, timestamp, details in records:
        print(f"{timestamp} | {status:12} | {Path(name).name}")
        if video_id:
            print(f"    https://www.youtube.com/watch?v={video_id}")
        if details:
            print(f"    {details[:250]}")


def manual_retry(db, filename, options):
    target = Path(filename)
    if not target.is_absolute():
        target = ROOT / target
    if not target.is_file():
        print(f"File not found: {target}")
        return
    stat = target.stat()
    fingerprint = video_fingerprint(target, stat)
    row = db.execute(
        "SELECT status FROM uploads WHERE fingerprint = ?", (fingerprint,)
    ).fetchone()
    if not row or row[0] == "uploaded":
        print("This file is not in a retryable state (or it was already uploaded).")
        return
    print("WARNING: The prior attempt could have reached YouTube successfully.")
    print("Check YouTube Studio first. Retrying without checking can create a duplicate.")
    if input("Type RETRY after checking YouTube Studio: ").strip() == "RETRY":
        db.execute("DELETE FROM uploads WHERE fingerprint = ?", (fingerprint,))
        db.commit()
        print("Cleared the blocked attempt. Restart start_uploader.bat to retry it.")
    else:
        print("No changes made.")


def run_watcher(db, service, options):
    folder = options["watch_folder"]
    observed = {}  # path -> ((size, mtime_ns), monotonic_time_when_first_seen)
    logging.info("Watching %s", folder)
    logging.info("New videos upload as %s; press Ctrl+C to stop.", options["privacy_status"])

    pending = db.execute(
        "SELECT file_path FROM uploads WHERE status != 'uploaded' ORDER BY updated_utc"
    ).fetchall()
    for (name,) in pending:
        logging.warning("Needs manual review (will NOT auto-retry): %s", name)

    while True:
        # Polling, rather than depending on a filesystem-event library, also
        # catches files that arrive while the program is closed or uploading.
        try:
            files = sorted(folder.iterdir(), key=lambda p: p.name.casefold())
        except OSError:
            logging.exception("Cannot access watch folder. Retrying shortly.")
            time.sleep(options["scan_every_seconds"])
            continue

        current = set()
        for file in files:
            try:
                if not file.is_file() or file.suffix.lower() not in VIDEO_EXTENSIONS:
                    continue
                stat = file.stat()
                if stat.st_size == 0:
                    continue
                current.add(str(file))
                signature = (stat.st_size, stat.st_mtime_ns)
                prior = observed.get(str(file))
                if not prior or prior[0] != signature:
                    observed[str(file)] = (signature, time.monotonic())
                    continue
                if time.monotonic() - prior[1] < options["stable_seconds"]:
                    continue

                fingerprint = video_fingerprint(file, stat)
                row = db.execute(
                    "SELECT status FROM uploads WHERE fingerprint = ?", (fingerprint,)
                ).fetchone()
                if row:
                    continue

                # Set the state BEFORE starting upload. If the PC crashes or
                # the response is lost, do not blindly upload again.
                mark_status(db, fingerprint, file, "uploading")
                logging.info("Starting: %s", file.name)
                try:
                    video_id = upload_video(service, file, options)
                    mark_status(db, fingerprint, file, "uploaded", video_id=video_id)
                    logging.info("SUCCESS: https://www.youtube.com/watch?v=%s", video_id)
                except Exception as exc:
                    # Failure after upload initiation can be ambiguous; manual
                    # check protects against accidental duplicate uploads.
                    mark_status(db, fingerprint, file, "needs_review", details=str(exc))
                    logging.exception(
                        "Upload uncertain/failed: %s. Check YouTube Studio before retrying.",
                        file.name,
                    )
            except (OSError, sqlite3.Error):
                logging.exception("Could not inspect or record %s. Will rescan.", file)

        for missing in set(observed) - current:
            observed.pop(missing, None)

        time.sleep(options["scan_every_seconds"])


@contextmanager
def single_instance():
    lock = open(LOCK_FILE, "a+b")
    try:
        lock.seek(0, 2)
        if lock.tell() == 0:
            lock.write(b"0")
            lock.flush()
        lock.seek(0)
        if sys.platform == "win32":
            import msvcrt
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as exc:
                raise RuntimeError("Uploader is already running in another window.") from exc
            try:
                yield
            finally:
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                raise RuntimeError("Uploader is already running in another window.") from exc
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    finally:
        lock.close()


def main():
    parser = argparse.ArgumentParser(description="Upload new videos in a Windows folder to YouTube.")
    parser.add_argument("--authorize", action="store_true", help="Sign in to Google and exit")
    parser.add_argument("--history", action="store_true", help="Show upload history and exit")
    parser.add_argument("--retry", metavar="PATH", help="Manually clear a failed upload after review")
    args = parser.parse_args()

    configure_logging()
    options = load_settings()
    if args.history:
        # Read-only history remains available even while the watcher is running.
        db = open_database()
        try:
            history(db)
        finally:
            db.close()
        return

    with single_instance():
        db = open_database()
        try:
            if args.retry:
                manual_retry(db, args.retry, options)
            elif args.authorize:
                authorize()
                print("YouTube authorization saved. You're ready to run start_uploader.bat.")
            else:
                run_watcher(db, youtube_service(), options)
        finally:
            db.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped. Uploaded-video history is saved.")
    except Exception as exc:
        logging.exception("Could not start uploader: %s", exc)
        print("See uploader.log and README.md for setup help.")
        sys.exit(1)

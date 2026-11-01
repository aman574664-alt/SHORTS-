// Explicit owner-requested release of the already processed subset. No uploads.
const { app, safeStorage } = require("electron"),
  fs = require("node:fs"),
  path = require("node:path");
const { Vault } = require("../lib/storage.cjs");
const { Queue } = require("../lib/queue.cjs");
app.setName("Shorts Scheduler");
app
  .whenReady()
  .then(() => {
    if (!process.argv.includes("--release-processed-only"))
      throw Error("Explicit release flag required.");
    const home = app.getPath("userData"),
      vault = new Vault(path.join(home, "credentials.bin"), safeStorage),
      q = new Queue(path.join(home, "library-v2.json"), vault, {});
    q.state.paused = true;
    for (const i of q.state.items) {
      if (
        i.status === "needs_review" &&
        !i.videoId &&
        !i.offset &&
        !vault.get("session:" + i.id) &&
        i.error.startsWith("YouTube quota or channel upload limit reached.")
      ) {
        i.initiated = false;
        i.status = "failed";
        i.error =
          "YouTube rejected this upload before any video data was sent: quota or channel upload limit reached. Retry after the limit clears.";
      }
    }
    const batch = q.state.batches.find((b) => b.status === "uploading");
    const released = q.releaseReadyBatch(batch.id);
    q.state.paused = false;
    q.save();
    console.log(
      JSON.stringify({
        released,
        held: q.state.items.filter((i) => i.status === "failed").length,
        scheduledItems: q.state.items
          .filter((i) => i.mode === "schedule")
          .map((i) => ({
            file: path.basename(i.path),
            at: i.at,
            videoId: i.videoId,
          })),
      }),
    );
    app.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    app.exit(1);
  });

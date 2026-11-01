// Owner-authorized local batch preparation. Does not itself send any video bytes.
const { app, safeStorage } = require("electron");
const fs = require("node:fs"),
  path = require("node:path");
const { Vault } = require("../lib/storage.cjs");
const { Auth } = require("../lib/auth.cjs");
const { YouTube } = require("../lib/youtube.cjs");
const { Queue } = require("../lib/queue.cjs");
const { inspect } = require("./inspect-media.cjs");
app.setName("Shorts Scheduler");
app
  .whenReady()
  .then(async () => {
    let folder = process.argv.find((x) => x.startsWith("--folder="))?.slice(9);
    const audience = process.argv
      .find((x) => x.startsWith("--audience="))
      ?.slice(11);
    if (
      !folder ||
      !["yes", "no"].includes(audience) ||
      !process.argv.includes("--approve-public-one-minute")
    )
      throw Error(
        "Explicit folder, audience, and public batch approval are required.",
      );
    folder = path.resolve(folder);
    const vault = new Vault(
        path.join(app.getPath("userData"), "credentials.bin"),
        safeStorage,
      ),
      auth = new Auth(vault, () => {
        throw Error("Connect through the app first.");
      }),
      api = new YouTube(auth);
    const q = new Queue(
      path.join(app.getPath("userData"), "library-v2.json"),
      vault,
      api,
    );
    const channel = await api.channel();
    if (!q.state.channel || q.state.channel.id !== channel.id)
      throw Error("Connect and verify the intended channel first.");
    q.state.paused = true;
    q.state.folder = folder;
    q.save();
    await q.scan();
    console.log("Waiting 31 seconds for completed-file stability.");
    await new Promise((resolve) => setTimeout(resolve, 31000));
    await q.scan();
    const input = fs.readdirSync(folder).filter((n) => /\.mp4$/i.test(n));
    const items = q.state.items.filter(
      (i) =>
        path.dirname(i.path) === folder &&
        i.status === "pending" &&
        !i.initiated,
    );
    for (const i of items) {
      try {
        i.mediaInfo = inspect(i.path);
      } catch {}
      i.mediaReviewed = true;
    }
    q.state.liveEnabled = true;
    const batch = q.createBatch(
      items.map((i) => i.id),
      {
        spacingMinutes: 1,
        audience,
        mediaReviewed: true,
        publishConsent: true,
      },
    );
    q.state.paused = false;
    q.save();
    console.log(
      JSON.stringify({
        channel: channel.title,
        inputFiles: input.length,
        uniqueQueued: items.length,
        batch,
        posting: "Public, one minute apart after all uploads finish processing",
        audience: audience === "yes" ? "Made for kids" : "Not made for kids",
        items: items.map((i) => ({
          file: path.basename(i.path),
          shortEligible: i.mediaInfo?.shortEligible,
        })),
      }),
    );
    app.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    app.exit(1);
  });

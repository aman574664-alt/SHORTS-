// Read-only server verification. Outputs video status, never credentials or sessions.
const { app, safeStorage } = require("electron");
const fs = require("node:fs"),
  path = require("node:path");
const { Vault } = require("../lib/storage.cjs");
const { Auth } = require("../lib/auth.cjs");
const { YouTube } = require("../lib/youtube.cjs");
app.setName("Shorts Scheduler");
app
  .whenReady()
  .then(async () => {
    const home = app.getPath("userData"),
      state = JSON.parse(
        fs.readFileSync(path.join(home, "library-v2.json"), "utf8"),
      );
    const vault = new Vault(path.join(home, "credentials.bin"), safeStorage),
      auth = new Auth(vault, () => {
        throw Error("Connect in the app.");
      }),
      api = new YouTube(auth);
    const ids = state.items.filter((i) => i.videoId).map((i) => i.videoId);
    if (!ids.length) {
      console.log("No completed upload yet.");
      app.exit(0);
      return;
    }
    const r = await api.request(
      "https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=" +
        ids.join(","),
    );
    console.log(
      JSON.stringify(
        r.items.map((v) => ({
          file: path.basename(state.items.find((i) => i.videoId === v.id).path),
          id: v.id,
          uploadStatus: v.status?.uploadStatus,
          processingStatus: v.processingDetails?.processingStatus,
          privacy: v.status?.privacyStatus,
          publishAt: v.status?.publishAt,
          madeForKids: v.status?.selfDeclaredMadeForKids,
        })),
        null,
        2,
      ),
    );
    app.exit(0);
  })
  .catch((e) => {
    console.error(e.message);
    app.exit(1);
  });

// Connect the owner's channel using a local Desktop OAuth JSON. Never logs secrets.
const { app, safeStorage, shell } = require("electron");
const fs = require("node:fs"),
  path = require("node:path");
const { Vault } = require("../lib/storage.cjs");
const { Auth } = require("../lib/auth.cjs");
const { YouTube } = require("../lib/youtube.cjs");
const { Queue } = require("../lib/queue.cjs");
app.setName("Shorts Scheduler");
app
  .whenReady()
  .then(async () => {
    const clientFile = process.argv
      .find((x) => x.startsWith("--client-file="))
      ?.slice(14);
    const vault = new Vault(
      path.join(app.getPath("userData"), "credentials.bin"),
      safeStorage,
    );
    const auth = new Auth(vault, (url) => shell.openExternal(url));
    const api = new YouTube(auth);
    const q = new Queue(
      path.join(app.getPath("userData"), "library-v2.json"),
      vault,
      api,
    );
    q.state.paused = true;
    q.state.liveEnabled = false;
    q.save();
    if (clientFile)
      auth.importClient(await fs.promises.readFile(clientFile, "utf8"));
    let channel;
    if (vault.get("tokens")) {
      try {
        channel = await api.channel();
      } catch {}
    }
    if (!channel) {
      console.log(
        "GOOGLE_SIGN_IN_OPEN: Complete account selection and consent in your browser.",
      );
      await auth.connect(
        process.argv.find((x) => x.startsWith("--login-hint="))?.slice(13) ||
          "",
      );
      channel = await api.channel();
    }
    if (q.state.channel && q.state.channel.id !== channel.id) {
      vault.set("tokens", null);
      throw Error(
        "Selected channel differs from this library. Connect the original channel.",
      );
    }
    q.state.channel = channel;
    q.save();
    console.log(
      JSON.stringify({
        connected: true,
        channel: channel.title,
        channelId: channel.id,
        uploadsEnabled: false,
      }),
    );
    app.exit(0);
  })
  .catch((e) => {
    console.error("CONNECTION_FAILED: " + e.message);
    app.exit(1);
  });

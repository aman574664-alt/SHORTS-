const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  safeStorage,
  shell,
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { Vault } = require("./lib/storage.cjs");
const { Auth } = require("./lib/auth.cjs");
const { YouTube } = require("./lib/youtube.cjs");
const { Queue } = require("./lib/queue.cjs");
let window,
  queue,
  timer,
  scanning = false;
app.setName("Shorts Scheduler");
function focus() {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}
app.on("second-instance", focus);
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      const home = app.getPath("userData");
      const vault = new Vault(path.join(home, "credentials.bin"), safeStorage);
      const auth = new Auth(vault, (url) => shell.openExternal(url));
      const youtube = new YouTube(auth);
      queue = new Queue(path.join(home, "library-v2.json"), vault, youtube);
      for (const i of queue.state.items) i.verifiedRun = false;
      function handle(name, fn) {
        ipcMain.handle(name, async (_, value) => {
          const exclusive = [
            "action",
            "reschedule",
            "connect",
            "disconnect",
            "thumbnail",
            "approve",
            "edit",
            "nextSlot",
            "settings",
            "enable",
            "importClient",
          ].includes(name);
          if (exclusive && (queue.busy || queue.userBusy))
            return {
              ok: false,
              error:
                "Pause the queue and wait for the current request to finish, then try again.",
            };
          if (exclusive) queue.userBusy = true;
          try {
            return { ok: true, data: await fn(value) };
          } catch (e) {
            return { ok: false, error: e.message };
          } finally {
            if (exclusive) queue.userBusy = false;
          }
        });
      }
      async function confirm(title, message, detail, button = "Confirm") {
        const r = await dialog.showMessageBox(window, {
          type: "question",
          title,
          message,
          detail,
          buttons: ["Cancel", button],
          defaultId: 0,
          cancelId: 0,
        });
        return r.response === 1;
      }
      handle("state", () => ({
        ...queue.view(),
        hasClient: !!vault.get("client"),
        connected: !!vault.get("tokens"),
        connecting: auth.connecting,
        startup: app.getLoginItemSettings().openAtLogin,
      }));
      handle("folder", async () => {
        const r = await dialog.showOpenDialog(window, {
          properties: ["openDirectory"],
        });
        if (!r.canceled) {
          queue.state.folder = r.filePaths[0];
          queue.observed.clear();
          queue.save();
        }
      });
      handle("importClient", async () => {
        const r = await dialog.showOpenDialog(window, {
          title: "Choose your Google Desktop app JSON",
          filters: [{ name: "Google OAuth app", extensions: ["json"] }],
          properties: ["openFile"],
        });
        if (vault.get("tokens"))
          throw Error(
            "Disconnect locally before importing a different Google app.",
          );
        if (!r.canceled)
          auth.importClient(await fs.promises.readFile(r.filePaths[0], "utf8"));
      });
      handle("connect", async () => {
        if (queue.busy)
          throw Error(
            "Pause the queue and wait for the current request to finish before connecting.",
          );
        queue.state.paused = true;
        queue.state.liveEnabled = false;
        queue.save();
        await auth.connect();
        const c = await youtube.channel();
        if (queue.state.channel && c.id !== queue.state.channel.id) {
          vault.set("tokens", null);
          throw Error(
            "This library belongs to a different channel. Connect the original channel.",
          );
        }
        queue.state.channel = c;
        queue.save();
      });
      handle("disconnect", async () => {
        if (queue.busy)
          throw Error("Wait for the current upload request to finish.");
        queue.state.paused = true;
        queue.state.liveEnabled = false;
        vault.set("tokens", null);
        queue.save();
      });
      handle("enable", async () => {
        if (!vault.get("tokens") || !queue.state.channel)
          throw Error("Connect YouTube first.");
        if (
          await confirm(
            "Enable real uploads",
            "Allow this app to upload reviewed videos to your channel?",
            "Videos are uploaded privately first. Scheduling public release requires a separate approval for each video. Your PC must be awake and online during upload.",
            "Enable uploads",
          )
        ) {
          queue.state.liveEnabled = true;
          queue.save();
        }
      });
      handle("pause", () => {
        queue.state.paused = !queue.state.paused;
        queue.save();
      });
      handle("settings", (s) => {
        queue.settings(s);
        app.setLoginItemSettings({
          openAtLogin: !!s.startup,
          path: process.execPath,
          args: app.isPackaged ? [] : [app.getAppPath()],
        });
      });
      handle("edit", (v) => queue.edit(v));
      handle("reschedule", async (v) => {
        if (!queue.state.liveEnabled)
          throw Error(
            "Enable reviewed uploads before scheduling a public release.",
          );
        const i = queue.item(v.id);
        if (queue.busy) throw Error("Wait for the current request to finish.");
        if (["published", "cancelled"].includes(i.status))
          throw Error("This video cannot be rescheduled here.");
        const at = require("luxon").DateTime.fromISO(v.localTime, {
          zone: queue.state.zone,
        });
        if (!at.isValid || at.toMillis() < Date.now() + 60000)
          throw Error("Choose a future posting time.");
        if (
          queue.state.items.some(
            (x) =>
              x.id !== i.id &&
              x.status !== "cancelled" &&
              x.mode === "schedule" &&
              Date.parse(x.at) === at.toMillis(),
          )
        )
          throw Error("That slot is already reserved.");
        if (
          !(await confirm(
            "Change public release",
            "Schedule this video for the new time?",
            at.toFormat("dd LLL yyyy HH:mm") + " (" + queue.state.zone + ")",
            "Approve new schedule",
          ))
        )
          return;
        const update = {
          ...i,
          at: at.toUTC().toISO(),
          mode: "schedule",
          publishConsent: true,
        };
        if (i.videoId) {
          await youtube.schedule(update);
          update.status = "scheduled";
        } else if (i.status === "failed") update.status = "paused";
        Object.assign(i, update, { error: "", nextAttempt: 0 });
        queue.save();
      });
      handle("nextSlot", (id) => {
        const i = queue.item(id);
        if (i.initiated)
          throw Error("Use YouTube Studio to change an uploaded video.");
        i.at = queue.next(Date.now(), id);
        i.status = "pending";
        i.publishConsent = false;
        queue.save();
      });
      handle("approve", async (id) => {
        const i = queue.item(id);
        if (!queue.state.liveEnabled)
          throw Error("Enable real uploads in Connect first.");
        queue.validateApproval(i);
        if (
          i.mode === "schedule" &&
          !(await confirm(
            "Schedule public release",
            `Schedule “${i.title}” for public release?`,
            `${queue.view().items.find((x) => x.id === id).displayTime} (${queue.state.zone}). After uploading, YouTube will publish it even while your PC is off.`,
            "Approve schedule",
          ))
        )
          return;
        queue.approve(i);
      });
      handle("action", async (v) => {
        const i = queue.item(v.id);
        if (queue.busy)
          throw Error(
            "Wait for the current request to finish, then try again.",
          );
        if (v.action === "pause") {
          if (["ready", "uploading"].includes(i.status)) i.status = "paused";
        } else if (v.action === "cancel") {
          if (
            !(await confirm(
              "Cancel video",
              "Stop this video in the app?",
              i.videoId
                ? "This also removes its future schedule on YouTube and makes it private. It does not delete the video."
                : "An upload already sent may exist privately on YouTube. Your source file stays in place.",
              "Cancel video",
            ))
          )
            return;
          if (i.videoId) await youtube.keepPrivate(i.videoId, i.audience);
          else if (i.initiated) {
            await queue.reconcile(i);
            if (i.videoId) await youtube.keepPrivate(i.videoId, i.audience);
          }
          i.status = "cancelled";
          i.error = "";
          i.publishConsent = false;
        } else if (v.action === "reconcile") {
          await queue.reconcile(i);
        } else if (v.action === "retry") {
          if (i.status !== "failed" && i.status !== "needs_review")
            throw Error("Only a failed upload can be retried.");
          if (!queue.state.liveEnabled)
            throw Error("Enable reviewed uploads first.");
          if (i.status === "needs_review")
            throw Error(
              "Reconcile this upload first. No duplicate will be uploaded automatically.",
            );
          if (i.mode === "schedule" && Date.parse(i.at) < Date.now() + 60000)
            throw Error(
              "Missed slot. Edit the time before retrying, or change it in YouTube Studio if already uploaded.",
            );
          i.status = i.videoId ? "processing" : "ready";
          i.needsProbe = true;
          i.nextAttempt = 0;
          i.attempts = 0;
          i.error = "";
        } else throw Error("Unknown action.");
        queue.save();
      });
      handle("thumbnail", async (id) => {
        const i = queue.item(id);
        if (i.initiated || ["ready", "uploading"].includes(i.status))
          throw Error("Choose a thumbnail before queuing the upload.");
        const r = await dialog.showOpenDialog(window, {
          filters: [{ name: "Thumbnail", extensions: ["jpg", "jpeg", "png"] }],
          properties: ["openFile"],
        });
        if (!r.canceled) {
          if ((await fs.promises.stat(r.filePaths[0])).size > 2 * 1024 * 1024)
            throw Error("Choose a JPG or PNG under 2 MB.");
          i.thumbnail = r.filePaths[0];
          queue.save();
        }
      });
      const links = {
        cloud:
          "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
        oauth: "https://console.cloud.google.com/auth/clients",
        consent: "https://console.cloud.google.com/auth/audience",
        studio: "https://studio.youtube.com/",
        terms: "https://www.youtube.com/t/terms",
        privacy: "https://policies.google.com/privacy",
      };
      handle("link", (key) => {
        if (!links[key]) throw Error("Unknown link.");
        return shell.openExternal(links[key]);
      });
      handle("videoLink", (id) => {
        const i = queue.item(id);
        if (!/^[\w-]{11}$/.test(i.videoId || ""))
          throw Error("Video is not uploaded yet.");
        return shell.openExternal(
          "https://www.youtube.com/watch?v=" + i.videoId,
        );
      });
      window = new BrowserWindow({
        title: "Shorts Scheduler",
        width: 1360,
        height: 900,
        minWidth: 960,
        minHeight: 680,
        backgroundColor: "#f3f0e9",
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (e) => e.preventDefault());
      await window.loadFile(path.join(__dirname, "index.html"));
      focus();
      window.on("closed", () => {
        window = null;
      });
      timer = setInterval(async () => {
        if (!scanning) {
          scanning = true;
          queue
            .scan()
            .catch(() => {
              queue.state.warning =
                "Could not save the library. Check available disk space.";
            })
            .finally(() => {
              scanning = false;
            });
        }
        await queue.step().catch(() => {
          queue.state.warning =
            "Could not save upload progress. Pause and check disk space.";
          queue.state.paused = true;
        });
      }, 1500);
    })
    .catch((e) => {
      dialog.showErrorBox("Shorts Scheduler could not start", e.message);
      app.quit();
    });
app.on("before-quit", () => {
  clearInterval(timer);
});
app.on("window-all-closed", () => app.quit());

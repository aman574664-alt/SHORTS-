// Native Electron smoke checks. All files and credentials are synthetic and isolated.
const { app, BrowserWindow, safeStorage } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "shorts-desktop-"));
app.setPath("userData", temp);
const future = new Date(Date.now() + 86400000).toISOString();
fs.writeFileSync(
  path.join(temp, "library-v2.json"),
  JSON.stringify({
    version: 2,
    folder: "C:\\Videos\\Finished Shorts",
    zone: "Asia/Kolkata",
    slots: ["08:00", "10:30", "13:00", "15:30", "18:00", "20:30"],
    paused: true,
    liveEnabled: false,
    channel: null,
    items: [
      {
        id: "a".repeat(64),
        path: "C:\\Videos\\Finished Shorts\\Morning routine.mp4",
        size: 24576000,
        title: "A quieter kind of morning",
        description: "A small moment, worth keeping.",
        audience: "no",
        shortConfirmed: true,
        mode: "schedule",
        at: future,
        status: "pending",
        progress: 0,
        offset: 0,
        error: "",
      },
    ],
  }),
);
const output = path.join(root, "output");
fs.mkdirSync(output, { recursive: true });
let done = false;
setTimeout(() => {
  if (!done) {
    console.error("Desktop smoke timed out");
    app.exit(1);
  }
}, 20000).unref();
app.on("browser-window-created", (_, w) => {
  w.webContents.once("did-finish-load", () =>
    setTimeout(async () => {
      try {
        const { Vault } = require("../lib/storage.cjs");
        const vault = new Vault(path.join(temp, "test.bin"), safeStorage);
        vault.set("test", "synthetic-sensitive-value");
        assert.ok(
          !fs
            .readFileSync(path.join(temp, "test.bin"))
            .includes(Buffer.from("synthetic-sensitive-value")),
        );
        assert.equal(
          new Vault(path.join(temp, "test.bin"), safeStorage).get("test"),
          "synthetic-sensitive-value",
        );
        const errors = [];
        w.webContents.on("console-message", (event) => {
          if (event.level === "error" || event.level === 3)
            errors.push(event.message);
        });
        const run = (code) => w.webContents.executeJavaScript(code);
        assert.equal(
          await run("document.querySelectorAll('.video-row').length"),
          1,
        );
        assert.match(
          await run("document.getElementById('connection').textContent"),
          /NOT CONNECTED/,
        );
        fs.writeFileSync(
          path.join(output, "queue.png"),
          (await w.webContents.capturePage()).toPNG(),
        );
        await run("document.querySelector('.video-row').click()");
        assert.equal(await run("document.getElementById('editor').open"), true);
        await run(
          "document.getElementById('title').value='Edited from the desktop UI';document.getElementById('editForm').dispatchEvent(new Event('input'));document.querySelector('#editActions button').click()",
        );
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(
          (await run("window.api.state()")).items[0].title,
          "Edited from the desktop UI",
        );
        fs.writeFileSync(
          path.join(output, "editor.png"),
          (await w.webContents.capturePage()).toPNG(),
        );
        await assert.rejects(
          () => run("window.api.approve('" + "a".repeat(64) + "')"),
          /Enable real uploads/,
        );
        await run(
          "document.getElementById('editor').close();document.querySelector('[data-page=connect]').click()",
        );
        assert.equal(
          await run("document.getElementById('page-connect').hidden"),
          false,
        );
        assert.equal(
          await run("document.getElementById('connect').disabled"),
          true,
        );
        fs.writeFileSync(
          path.join(output, "connect.png"),
          (await w.webContents.capturePage()).toPNG(),
        );
        await run("document.querySelector('[data-page=schedule]').click()");
        assert.equal(
          await run("document.getElementById('zone').value"),
          "Asia/Kolkata",
        );
        assert.equal(
          await run("document.querySelectorAll('#slotInputs input').length"),
          6,
        );
        assert.equal(
          await run("document.body.scrollWidth<=window.innerWidth"),
          true,
        );
        assert.equal(errors.length, 0, errors.join("\n"));
        done = true;
        console.log(
          "PASS: native UI, queue rendering, editor persistence, upload gate, setup navigation, six slots, Windows encryption.",
        );
        app.exit(0);
      } catch (e) {
        done = true;
        console.error(e);
        app.exit(1);
      }
    }, 450),
  );
});
require("../main.cjs");

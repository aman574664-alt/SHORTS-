const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const dest = path.join(root, "release", "ShortsScheduler");
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(path.join(root, "node_modules/electron/dist"), dest, {
  recursive: true,
});
const app = path.join(dest, "resources", "app");
fs.mkdirSync(app, { recursive: true });
for (const file of [
  "main.cjs",
  "preload.cjs",
  "index.html",
  "styles.css",
  "ui.js",
  "package.json",
])
  fs.copyFileSync(path.join(root, file), path.join(app, file));
fs.cpSync(path.join(root, "lib"), path.join(app, "lib"), { recursive: true });
fs.mkdirSync(path.join(app, "node_modules"), { recursive: true });
fs.cpSync(
  path.join(root, "node_modules/luxon"),
  path.join(app, "node_modules/luxon"),
  { recursive: true },
);
const exe = path.join(dest, "ShortsScheduler.exe");
if (fs.existsSync(exe)) fs.unlinkSync(exe);
fs.renameSync(path.join(dest, "electron.exe"), exe);
fs.copyFileSync(
  path.join(root, "START HERE.txt"),
  path.join(dest, "START HERE.txt"),
);
console.log("Windows app ready: " + exe);

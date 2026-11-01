const fs = require("node:fs");
const path = require("node:path");
function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file + ".tmp", "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) fs.copyFileSync(file, file + ".bak");
  fs.renameSync(file + ".tmp", file);
}
function read(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(file + ".bak", "utf8"));
    } catch {
      throw Error(
        "Local data could not be read. Keep the data files and restore a backup.",
      );
    }
  }
}
class Vault {
  constructor(file, safeStorage) {
    this.file = file;
    this.safe = safeStorage;
    this.data = {};
    if (fs.existsSync(file)) {
      if (!this.safe.isEncryptionAvailable())
        throw Error("Windows credential protection is unavailable.");
      this.data = JSON.parse(this.safe.decryptString(fs.readFileSync(file)));
    }
  }
  get(key) {
    return this.data[key];
  }
  set(key, value) {
    if (!this.safe.isEncryptionAvailable())
      throw Error("Windows credential protection is unavailable.");
    this.data[key] = value;
    const bytes = this.safe.encryptString(JSON.stringify(this.data));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + ".tmp", bytes);
    fs.renameSync(this.file + ".tmp", this.file);
  }
}
module.exports = { atomic, read, Vault };

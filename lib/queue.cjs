const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DateTime } = require("luxon");
const { atomic, read } = require("./storage.cjs");
async function fingerprint(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
class Queue {
  constructor(file, vault, api) {
    this.file = file;
    this.vault = vault;
    this.api = api;
    this.observed = new Map();
    this.busy = false;
    this.state = read(file, {
      version: 2,
      folder: "",
      zone: "Asia/Kolkata",
      slots: ["08:00", "10:30", "13:00", "15:30", "18:00", "20:30"],
      paused: true,
      liveEnabled: false,
      channel: null,
      items: [],
    });
    // Legacy demo progress must never be mistaken for a real YouTube upload.
    if (this.state.version !== 2) {
      this.state.items = [];
      this.state.version = 2;
      this.state.liveEnabled = false;
      this.state.paused = true;
    }
    for (const i of this.state.items) {
      i.verifiedRun = false;
      if (i.initiated && !i.videoId) i.needsProbe = true;
    }
    for (const i of this.state.items)
      if (i.status === "uploading") {
        i.status = "ready";
        i.needsProbe = true;
      }
    this.state.manualFiles ||= [];
    this.state.batches ||= [];
    this.save();
  }
  addFiles(files) {
    this.state.manualFiles = [
      ...new Set([
        ...(this.state.manualFiles || []),
        ...files.filter(
          (file) =>
            path.isAbsolute(file) &&
            /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file),
        ),
      ]),
    ];
    this.save();
  }
  save() {
    atomic(this.file, JSON.stringify(this.state, null, 2));
  }
  next(now = Date.now(), exclude) {
    for (let d = 0; d < 366; d++)
      for (const slot of [...this.state.slots].sort()) {
        const [hour, minute] = slot.split(":").map(Number);
        const t = DateTime.fromMillis(now, { zone: this.state.zone })
          .startOf("day")
          .plus({ days: d })
          .set({ hour, minute });
        if (
          t.isValid &&
          t.toMillis() > now + 3600000 &&
          !this.state.items.some(
            (i) =>
              i.id !== exclude &&
              i.mode === "schedule" &&
              i.status !== "cancelled" &&
              Date.parse(i.at) === t.toMillis(),
          )
        )
          return t.toUTC().toISO();
      }
    throw Error("All slots for the next year are reserved.");
  }
  settings(s) {
    if (!DateTime.now().setZone(s.zone).isValid)
      throw Error("Choose a valid timezone, such as Asia/Kolkata.");
    if (
      !Array.isArray(s.slots) ||
      s.slots.length !== 6 ||
      new Set(s.slots).size !== 6 ||
      s.slots.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(x))
    )
      throw Error("Choose six different daily times.");
    this.state.zone = s.zone;
    this.state.slots = s.slots;
    this.save();
  }
  async scan() {
    if (!this.state.folder && !this.state.manualFiles?.length) return;
    let files = [];
    this.state.warning = "";
    if (this.state.folder) {
      try {
        files = (await fs.promises.readdir(this.state.folder)).map((name) =>
          path.join(this.state.folder, name),
        );
      } catch {
        this.state.warning =
          "Video folder is disconnected or unavailable. Reconnect the drive.";
      }
    }
    files = [...new Set([...files, ...(this.state.manualFiles || [])])];
    const found = new Set();
    for (const file of files.sort()) {
      const name = path.basename(file);
      if (!/\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(name)) continue;
      found.add(file);
      try {
        const st = await fs.promises.stat(file);
        if (!st.isFile() || st.size === 0) continue;
        const signature = `${st.size}:${st.mtimeMs}`;
        let old = this.observed.get(file);
        if (!old || old.signature !== signature) {
          old = { signature, since: Date.now() };
          this.observed.set(file, old);
          continue;
        }
        if (old.done || Date.now() - old.since < 30000) continue;
        const id = await fingerprint(file);
        const after = await fs.promises.stat(file);
        if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) {
          this.observed.delete(file);
          continue;
        }
        const existing = this.state.items.find((i) => i.id === id);
        if (existing) {
          if (!fs.existsSync(existing.path)) existing.path = file;
          old.done = true;
          continue;
        }
        const item = {
          id,
          path: file,
          size: st.size,
          mtime: st.mtimeMs,
          title: path.parse(name).name.replaceAll("_", " ").slice(0, 100),
          description: "",
          audience: "unset",
          mode: "schedule",
          at: "",
          status: "pending",
          progress: 0,
          offset: 0,
          error: "",
          created: new Date().toISOString(),
        };
        item.at = this.next();
        this.state.items.push(item);
        old.done = true;
      } catch {
        this.state.warning =
          "A video is still syncing or cannot be read. It will be checked again.";
      }
    }
    for (const p of this.observed.keys())
      if (!found.has(p)) this.observed.delete(p);
    this.save();
  }
  item(id) {
    const i = this.state.items.find((i) => i.id === id);
    if (!i) throw Error("Video not found.");
    return i;
  }
  edit(v) {
    const i = this.item(v.id);
    if (i.videoId || i.initiated || ["uploading", "ready"].includes(i.status))
      throw Error(
        "Pause this video before editing. Videos already sent to YouTube must be edited in Studio.",
      );
    if (
      typeof v.title !== "string" ||
      !v.title.trim() ||
      v.title.length > 100 ||
      /[<>]/.test(v.title) ||
      typeof v.description !== "string" ||
      v.description.length > 5000 ||
      /[<>]/.test(v.description)
    )
      throw Error(
        "Use a title up to 100 characters and description up to 5,000, without angle brackets.",
      );
    if (
      !["yes", "no", "unset"].includes(v.audience) ||
      !["private", "schedule"].includes(v.mode)
    )
      throw Error("Check the audience and visibility choices.");
    const at = DateTime.fromISO(v.localTime, { zone: this.state.zone });
    if (
      v.mode === "schedule" &&
      (!at.isValid || at.toMillis() < Date.now() + 60000)
    )
      throw Error("Choose a posting time at least one minute in the future.");
    if (
      v.mode === "schedule" &&
      this.state.items.some(
        (x) =>
          x.id !== i.id &&
          x.mode === "schedule" &&
          x.status !== "cancelled" &&
          Date.parse(x.at) === at.toMillis(),
      )
    )
      throw Error(
        "Another video has that posting slot. Choose a different time.",
      );
    if (i.batchId) {
      const batch = this.state.batches.find((b) => b.id === i.batchId);
      if (batch) {
        batch.ids = batch.ids.filter((id) => id !== i.id);
        if (!batch.ids.length) batch.status = "cancelled";
      }
      delete i.batchId;
      delete i.batchTarget;
    }
    Object.assign(i, {
      title: v.title.trim(),
      description: v.description,
      audience: v.audience,
      mode: v.mode,
      at: at.isValid ? at.toUTC().toISO() : i.at,
      status: "pending",
      error: "",
      publishConsent: false,
      shortConfirmed: !!v.shortConfirmed,
      mediaReviewed: !!v.mediaReviewed,
    });
    this.save();
  }
  validateApproval(i) {
    if (!this.state.channel) throw Error("Connect YouTube first.");
    if (!i.mediaReviewed && !i.shortConfirmed)
      throw Error("Review this finished video before approving upload.");
    if (i.audience === "unset")
      throw Error("Choose whether this video is made for kids first.");
    if (i.status !== "pending" && i.status !== "paused")
      throw Error("Only reviewed pending or paused videos can be queued.");
    if (i.mode === "schedule" && Date.parse(i.at) < Date.now() + 60000)
      throw Error(
        "This posting time has passed. Edit the video and choose a future time.",
      );
  }
  approve(i) {
    this.validateApproval(i);
    i.publishConsent = i.mode === "schedule";
    i.channelId = this.state.channel.id;
    i.status = "ready";
    i.error = "";
    this.save();
  }
  createBatch(ids, options) {
    if (!this.state.channel || !this.state.liveEnabled)
      throw Error("Connect YouTube and enable reviewed uploads first.");
    if (
      !["yes", "no"].includes(options.audience) ||
      !options.mediaReviewed ||
      !options.publishConsent
    )
      throw Error("Review the batch audience and approve public release.");
    const spacing = Number(options.spacingMinutes);
    if (!Number.isInteger(spacing) || spacing < 1 || spacing > 1440)
      throw Error("Choose spacing between 1 and 1,440 minutes.");
    const items = [...new Set(ids)].map((id) => this.item(id));
    if (
      !items.length ||
      items.some((i) => i.status !== "pending" || i.initiated)
    )
      throw Error("Select pending videos that have not been uploaded.");
    const id = crypto.randomUUID();
    const batch = {
      id,
      ids: items.map((i) => i.id),
      spacingMinutes: spacing,
      status: "uploading",
      publishConsent: true,
      created: new Date().toISOString(),
    };
    for (const i of items) {
      i.audience = options.audience;
      i.mediaReviewed = true;
      i.mode = "private";
      i.batchId = id;
      i.batchTarget = "schedule";
      this.approve(i);
    }
    this.state.batches.push(batch);
    this.save();
    return id;
  }
  releaseReadyBatch(id) {
    const batch = this.state.batches.find((b) => b.id === id);
    if (!batch || batch.status !== "uploading")
      throw Error("No waiting batch found.");
    const ready = batch.ids.filter((id) => {
      const i = this.item(id);
      return i.videoId && i.status === "private";
    });
    const held = batch.ids.filter((id) => !ready.includes(id));
    if (!ready.length) throw Error("No fully processed videos are ready.");
    if (held.length) {
      const deferred = {
        ...batch,
        id: crypto.randomUUID(),
        ids: held,
        parentBatchId: batch.id,
        created: new Date().toISOString(),
      };
      for (const id of held) this.item(id).batchId = deferred.id;
      this.state.batches.push(deferred);
    }
    batch.ids = ready;
    batch.deferredIds = held;
    this.prepareBatches();
    this.save();
    return ready.length;
  }
  prepareBatches(now = Date.now()) {
    for (const batch of this.state.batches) {
      if (batch.status === "scheduling") {
        const all = batch.ids.map((id) => this.item(id));
        if (
          all.every((i) =>
            ["scheduled", "published", "cancelled"].includes(i.status),
          )
        )
          batch.status = "scheduled";
        continue;
      }
      if (batch.status !== "uploading" || !batch.publishConsent) continue;
      const items = batch.ids
        .map((id) => this.item(id))
        .filter((i) => i.status !== "cancelled");
      if (!items.length) {
        batch.status = "cancelled";
        continue;
      }
      if (!items.every((i) => i.videoId && i.status === "private")) continue;
      let start = Math.ceil((now + 5 * 60000) / 60000) * 60000;
      const occupied = new Set(
        this.state.items
          .filter(
            (i) =>
              i.batchId !== batch.id &&
              i.mode === "schedule" &&
              i.status !== "cancelled",
          )
          .map((i) => Date.parse(i.at)),
      );
      while (
        items.some((_, n) =>
          occupied.has(start + n * batch.spacingMinutes * 60000),
        )
      )
        start += 60000;
      for (const [n, i] of items.entries()) {
        i.at = new Date(start + n * batch.spacingMinutes * 60000).toISOString();
        i.mode = "schedule";
        i.publishConsent = true;
        i.status = "processing";
        i.nextAttempt = 0;
        i.error = "";
      }
      batch.startAt = new Date(start).toISOString();
      batch.status = "scheduling";
      this.save();
    }
  }
  async acceptResponse(i, r) {
    if (r.status === 308) {
      const range = r.headers.get("range");
      i.offset = range ? Number(range.match(/(\d+)$/)?.[1]) + 1 : 0;
      if (!Number.isFinite(i.offset) || i.offset > i.size)
        throw Error("YouTube returned an invalid upload offset.");
      i.progress = Math.floor((i.offset / i.size) * 100);
      i.needsProbe = false;
      return false;
    }
    const data = await r.json();
    if (!data.id)
      throw Error(
        "Upload response had no video ID. Reconcile before retrying.",
      );
    i.videoId = data.id;
    i.status = "processing";
    i.progress = 100;
    i.error = "";
    this.save();
    this.vault.set("session:" + i.id, null);
    return true;
  }
  async reconcile(i) {
    if (!this.state.channel) throw Error("Connect YouTube first.");
    if (i.channelId && i.channelId !== this.state.channel.id)
      throw Error("Connect the original YouTube channel.");
    const video = await this.api.reconcile(i, this.state.channel);
    if (video) {
      i.videoId = video.id;
      i.status = "processing";
      i.error = "";
      i.progress = 100;
    } else {
      i.status = "needs_review";
      i.error =
        "No matching upload found in the latest 2,000 uploads. Check YouTube Studio; a delayed upload may still appear. The app will not upload another copy automatically.";
    }
    this.save();
    return !!video;
  }
  async poll(i) {
    const v = await this.api.video(i.videoId);
    if (!v) {
      i.status = "needs_review";
      i.error =
        "This video is not visible to the connected channel. Check YouTube Studio.";
      return;
    }
    const s = v.status;
    if (
      ["failed", "rejected", "deleted"].includes(s.uploadStatus) ||
      ["failed", "terminated"].includes(v.processingDetails?.processingStatus)
    ) {
      i.status = "failed";
      i.error =
        "YouTube processing failed: " +
        (s.rejectionReason || s.failureReason || "check YouTube Studio");
      return;
    }
    if (s.privacyStatus === "public") {
      i.status = "published";
      return;
    }
    if (s.publishAt) {
      i.status = "scheduled";
      i.at = s.publishAt;
      if (Date.parse(i.at) < Date.now() - 300000)
        i.error =
          "Posting time has passed but YouTube still reports this video as private. Check Studio for restrictions.";
      return;
    }
    if (i.status === "scheduled") {
      i.status = "needs_review";
      i.error =
        "YouTube no longer reports the saved schedule. Check Studio before changing it.";
      return;
    }
    if (
      s.uploadStatus !== "processed" &&
      v.processingDetails?.processingStatus !== "succeeded"
    ) {
      i.status = "processing";
      return;
    }
    if (i.thumbnail && !i.thumbnailTried) {
      i.thumbnailTried = true;
      this.save();
      try {
        await this.api.thumbnail(i);
      } catch {
        i.thumbnailWarning =
          "YouTube did not accept the thumbnail. Add it in Studio if your channel supports Shorts thumbnails.";
      }
    }
    if (i.mode === "private") {
      i.status = "private";
      return;
    }
    await this.api.schedule(i);
    i.status = "scheduled";
    i.error = "";
  }
  async step() {
    if (
      this.busy ||
      this.userBusy ||
      !this.state.liveEnabled ||
      !this.state.channel
    )
      return;
    const now = Date.now();
    if (!this.state.paused) this.prepareBatches(now);
    const i =
      this.state.items.find(
        (x) =>
          ["processing", "scheduled"].includes(x.status) &&
          (!x.nextAttempt || x.nextAttempt <= now),
      ) ||
      (!this.state.paused &&
        this.state.items.find(
          (x) =>
            ["ready", "uploading"].includes(x.status) &&
            (!x.nextAttempt || x.nextAttempt <= now),
        ));
    if (!i) return;
    this.busy = true;
    try {
      if (i.channelId && i.channelId !== this.state.channel.id)
        throw Error("Connect the channel this video was queued for.");
      if (i.videoId) {
        await this.poll(i);
        i.nextAttempt = Date.now() + 60000;
      } else {
        if (i.mode === "schedule" && Date.parse(i.at) < Date.now() + 60000)
          throw Error(
            "Missed posting slot. Choose a new future time; this video will never be published immediately.",
          );
        if (!fs.existsSync(i.path))
          throw Error(
            "Video missing. Reconnect the drive or put the original video back.",
          );
        const stat = await fs.promises.stat(i.path);
        if (stat.size !== i.size)
          throw Error("Video changed after review. Restore the original file.");
        if (i.verifiedRun !== true) {
          if ((await fingerprint(i.path)) !== i.id)
            throw Error(
              "Video content changed after review. Restore the original file.",
            );
          i.uploadMtime = stat.mtimeMs;
          i.verifiedRun = true;
        } else if (stat.mtimeMs !== i.uploadMtime)
          throw Error(
            "Video changed while uploading. Restore the original file before retrying.",
          );
        let session = this.vault.get("session:" + i.id);
        if (!session) {
          if (i.initiated) {
            await this.reconcile(i);
            return;
          }
          i.initiated = true;
          i.status = "uploading";
          this.save();
          session = await this.api.initiate(i);
          this.vault.set("session:" + i.id, session);
          i.needsProbe = true;
        }
        i.status = "uploading";
        if (i.needsProbe) {
          const done = await this.acceptResponse(
            i,
            await this.api.probe(session, i.size),
          );
          if (done) return;
        }
        if (i.offset >= i.size) {
          i.needsProbe = true;
          i.nextAttempt = Date.now() + 5000;
          return;
        }
        i.needsProbe = true;
        this.save();
        await this.acceptResponse(
          i,
          await this.api.chunk(session, i, i.offset || 0),
        );
        i.attempts = 0;
        i.nextAttempt = 0;
      }
    } catch (e) {
      i.error = e.message;
      if (
        ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"].includes(
          e.code,
        ) &&
        !i.videoId &&
        !this.vault.get("session:" + i.id) &&
        !i.offset
      ) {
        i.initiated = false;
        i.status = "failed";
        i.rejectionCode = e.code;
      } else if (e.uncertain) {
        i.status = "needs_review";
        try {
          await this.reconcile(i);
        } catch {
          i.error =
            "Upload result uncertain. Use Reconcile when connected to YouTube.";
        }
      } else if (e.retry && (i.attempts || 0) < 7) {
        i.attempts = (i.attempts || 0) + 1;
        i.nextAttempt =
          Date.now() +
          Math.min(300000, 2000 * 2 ** i.attempts + Math.random() * 1000);
        i.needsProbe = true;
      } else {
        i.status =
          i.initiated && !i.videoId && !this.vault.get("session:" + i.id)
            ? "needs_review"
            : "failed";
      }
    } finally {
      this.busy = false;
      this.save();
    }
  }
  view() {
    return {
      ...this.state,
      busy: this.busy,
      items: this.state.items.map((i) => {
        const { verifiedRun, ...publicItem } = i;
        return {
          ...publicItem,
          localTime: DateTime.fromISO(i.at)
            .setZone(this.state.zone)
            .toFormat("yyyy-MM-dd'T'HH:mm"),
          displayTime: DateTime.fromISO(i.at)
            .setZone(this.state.zone)
            .toFormat("dd LLL · HH:mm"),
        };
      }),
    };
  }
}
module.exports = { Queue, fingerprint };

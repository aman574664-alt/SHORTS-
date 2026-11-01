const $ = (id) => document.getElementById(id);
let state,
  page = "queue",
  filter = "active",
  editing,
  dirty = false,
  refreshBusy = false,
  toastTimer;
const labels = {
  pending: "Needs review",
  ready: "Queued",
  uploading: "Uploading",
  paused: "Paused",
  processing: "Processing",
  scheduled: "Scheduled",
  published: "Published",
  private: "Private",
  failed: "Failed",
  needs_review: "Check upload",
  cancelled: "Cancelled",
};
function el(tag, text, cls) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 9000);
}
async function run(name, value, message) {
  try {
    const data = await window.api[name](value);
    if (message) toast(message);
    await refresh();
    return data;
  } catch (e) {
    toast(e.message);
    return false;
  }
}
function navigate(next) {
  page = next;
  document.querySelectorAll(".page").forEach((e) => {
    e.hidden = e.id !== "page-" + page;
  });
  document
    .querySelectorAll("[data-page]")
    .forEach((e) => e.classList.toggle("active", e.dataset.page === page));
  $("pageLabel").textContent = {
    queue: "YOUR DAILY PUBLISHING DESK",
    schedule: "A SCHEDULE THAT FITS YOUR DAY",
    connect: "SECURE GOOGLE CONNECTION",
    help: "A FEW THINGS WORTH KNOWING",
  }[page];
  if (page === "schedule" && state) fillSettings();
}
document.querySelectorAll("[data-page]").forEach((e) => {
  e.onclick = () => navigate(e.dataset.page);
});
document.querySelectorAll("[data-link]").forEach((e) => {
  e.onclick = () => run("link", e.dataset.link);
});
$("folder").onclick = () => run("folder");
$("addFiles").onclick = async () => {
  const count = await run("addFiles");
  if (count)
    toast(
      count +
        " videos selected. They will appear after 30 seconds of file stability.",
    );
};
$("pause").onclick = () => {
  if (!state?.liveEnabled) {
    navigate("connect");
    toast("Connect your channel and enable uploads first.");
    return;
  }
  run("pause");
};
$("importClient").onclick = () => run("importClient");
$("connect").onclick = async () => {
  $("connect").disabled = true;
  $("connect").textContent = "Finish sign-in in your browser…";
  await run("connect");
  $("connect").disabled = false;
};
$("disconnect").onclick = () =>
  run(
    "disconnect",
    undefined,
    "Local authorization cleared. History is saved.",
  );
$("enable").onclick = () => run("enable");
for (let n = 0; n < 6; n++) {
  const wrap = el("div"),
    label = el("label", "SLOT 0" + (n + 1)),
    input = el("input");
  label.htmlFor = "slot" + n;
  input.type = "time";
  input.id = "slot" + n;
  input.required = true;
  wrap.append(label, input);
  $("slotInputs").append(wrap);
}
function fillSettings() {
  $("zone").value = state.zone;
  state.slots.forEach((v, n) => {
    $("slot" + n).value = v;
  });
  $("startup").checked = state.startup;
}
$("scheduleForm").onsubmit = (e) => {
  e.preventDefault();
  run(
    "settings",
    {
      zone: $("zone").value.trim(),
      slots: Array.from({ length: 6 }, (_, n) => $("slot" + n).value),
      startup: $("startup").checked,
    },
    "Daily schedule saved.",
  );
};
$("filters").onclick = (e) => {
  if (e.target.dataset.filter) {
    filter = e.target.dataset.filter;
    renderList();
  }
};
function renderList() {
  if (!state) return;
  document
    .querySelectorAll("[data-filter]")
    .forEach((e) =>
      e.classList.toggle("selected", e.dataset.filter === filter),
    );
  const history = ["published", "private", "cancelled"];
  const items = [...state.items]
    .reverse()
    .filter(
      (i) =>
        filter === "all" ||
        (filter === "history"
          ? history.includes(i.status)
          : !history.includes(i.status)),
    );
  $("videoList").replaceChildren();
  $("total").textContent = String(items.length).padStart(2, "0");
  if (!items.length) {
    const empty = el("div", undefined, "empty"),
      text = el("div");
    text.append(
      el(
        "h3",
        state.items.length
          ? "A clean slate."
          : "Your next chapter starts here.",
      ),
      el(
        "p",
        state.items.length
          ? "No videos in this view. Switch to All videos to see your library."
          : "Choose a folder of finished Shorts. We’ll find the videos, give them a slot, and leave the final say to you.",
      ),
    );
    empty.append(el("span", "＋", "empty-symbol"), text);
    $("videoList").append(empty);
    return;
  }
  for (const i of items) {
    const row = el("button", undefined, "video-row"),
      info = el("div", undefined, "video-info");
    row.setAttribute("aria-label", "Edit " + i.title);
    info.append(
      el("strong", i.title),
      el(
        "small",
        i.error ||
          (i.size / 1048576).toFixed(1) +
            " MB · " +
            (i.mode === "private" ? "Private upload" : "Scheduled release"),
      ),
    );
    if (i.status === "uploading") {
      const p = el("div", undefined, "progress"),
        fill = el("span");
      fill.style.width = i.progress + "%";
      p.append(fill);
      info.append(p);
    }
    row.append(
      el("span", "▷", "video-icon"),
      info,
      el(
        "span",
        i.batchTarget && i.mode === "private"
          ? "AFTER BATCH"
          : i.mode === "private"
            ? "PRIVATE"
            : i.displayTime,
        "video-date",
      ),
      el(
        "span",
        (labels[i.status] || i.status) +
          (i.status === "uploading" ? " " + i.progress + "%" : ""),
        "status-tag status-" + i.status,
      ),
      el("span", "↗", "row-arrow"),
    );
    row.onclick = () => openEditor(i.id);
    $("videoList").append(row);
  }
}
function fillEditor(i) {
  $("editorHeading").textContent = i.title;
  $("editorPath").textContent = i.path;
  $("editorStatus").textContent = labels[i.status] || i.status;
  $("editorStatus").className = "status-tag status-" + i.status;
  $("editorError").hidden = !i.error && !i.thumbnailWarning;
  $("editorError").textContent = [i.error, i.thumbnailWarning]
    .filter(Boolean)
    .join(" ");
  $("title").value = i.title;
  $("description").value = i.description;
  $("audience").value = i.audience;
  $("mode").value = i.mode;
  $("postingTime").value = i.localTime;
  $("shortConfirmed").checked = !!i.mediaReviewed || !!i.shortConfirmed;
  $("timeLabel").textContent = "POSTING TIME · " + state.zone.toUpperCase();
  $("thumbnailName").textContent =
    i.thumbnail?.split(/[\\/]/).pop() || "Optional · JPG / PNG, up to 2 MB";
  const locked = !!i.initiated || ["ready", "uploading"].includes(i.status);
  for (const id of [
    "title",
    "description",
    "audience",
    "mode",
    "shortConfirmed",
    "thumbnail",
    "nextSlot",
  ])
    $(id).disabled = locked;
  $("uploadedNote").textContent = locked
    ? "Upload details are locked once sending begins. Use YouTube Studio to edit an uploaded video. Pausing stops local chunks; it does not stop an accepted YouTube schedule."
    : "Save your details, then approve the upload. Your original file stays in place.";
  $("editActions").replaceChildren();
  function action(label, fn, primary = false) {
    const b = el("button", label, primary ? "primary" : "secondary");
    b.type = "button";
    b.onclick = fn;
    $("editActions").append(b);
  }
  if (!locked) action("Save details", saveEditor);
  if (locked && !["published", "cancelled"].includes(i.status)) {
    action("Save new posting time", async () => {
      await run("reschedule", { id: i.id, localTime: $("postingTime").value });
      dirty = false;
      redrawEditor();
    });
  }
  if (["pending", "paused"].includes(i.status))
    action(
      i.mode === "private" ? "Approve private upload →" : "Approve schedule →",
      async () => {
        if (dirty) {
          toast("Save changes before approving.");
          return;
        }
        await run("approve", i.id);
        redrawEditor();
      },
      true,
    );
  if (["ready", "uploading"].includes(i.status))
    action("Pause video", async () => {
      await run("action", { id: i.id, action: "pause" });
      redrawEditor();
    });
  if (i.status === "failed")
    action(
      "Retry safely →",
      async () => {
        await run("action", { id: i.id, action: "retry" });
        redrawEditor();
      },
      true,
    );
  if (i.status === "needs_review")
    action(
      "Reconcile with YouTube →",
      async () => {
        await run("action", { id: i.id, action: "reconcile" });
        redrawEditor();
      },
      true,
    );
  if (i.videoId) action("Open on YouTube ↗", () => run("videoLink", i.id));
  if (!["cancelled", "published"].includes(i.status))
    action("Cancel video", async () => {
      await run("action", { id: i.id, action: "cancel" });
      redrawEditor();
    });
}
function redrawEditor() {
  const i = state?.items.find((x) => x.id === editing);
  if (i && !dirty) fillEditor(i);
}
function openEditor(id) {
  editing = id;
  dirty = false;
  fillEditor(state.items.find((i) => i.id === id));
  $("editor").showModal();
}
$("closeEditor").onclick = () => {
  $("editor").close();
};
$("editor").addEventListener("close", () => {
  editing = undefined;
  dirty = false;
});
$("editForm").oninput = () => {
  dirty = true;
};
$("editForm").onsubmit = (e) => {
  e.preventDefault();
  saveEditor();
};
async function saveEditor() {
  const result = await run("edit", {
    id: editing,
    title: $("title").value,
    description: $("description").value,
    audience: $("audience").value,
    mode: $("mode").value,
    localTime: $("postingTime").value,
    mediaReviewed: $("shortConfirmed").checked,
  });
  if (result !== false) {
    dirty = false;
    redrawEditor();
    toast("Video details saved.");
  }
}
$("thumbnail").onclick = async () => {
  await run("thumbnail", editing);
  const i = state.items.find((x) => x.id === editing);
  $("thumbnailName").textContent =
    i.thumbnail?.split(/[\\/]/).pop() || "No thumbnail selected";
};
$("nextSlot").onclick = async () => {
  if (dirty) {
    toast("Save your other changes first.");
    return;
  }
  await run("nextSlot", editing);
  redrawEditor();
};
async function refresh() {
  if (refreshBusy) return;
  refreshBusy = true;
  try {
    state = await window.api.state();
    $("channelName").textContent =
      state.channel?.title || "Your channel awaits.";
    $("channelStatus").textContent = state.connected
      ? "CONNECTED TO YOUTUBE"
      : "Connect once. Create often.";
    $("channelDot").classList.toggle("live", state.connected);
    $("connection").textContent = state.connected
      ? state.liveEnabled
        ? "● REAL UPLOADS ENABLED"
        : "● CONNECTED · UPLOADS OFF"
      : "○ NOT CONNECTED";
    $("folderPath").textContent =
      state.folder || "Choose where your finished videos live.";
    $("folderPath").title = state.folder;
    $("queueState").textContent = state.paused
      ? "QUEUE PAUSED"
      : "QUEUE RUNNING";
    $("queueDot").classList.toggle("live", !state.paused);
    $("pause").textContent = state.paused ? "Resume queue →" : "Pause queue Ⅱ";
    $("navCount").textContent = state.items.filter(
      (i) => !["published", "private", "cancelled"].includes(i.status),
    ).length;
    $("timezoneFoot").textContent = state.zone.toUpperCase();
    $("warning").hidden = !state.warning;
    $("warning").textContent = state.warning || "";
    $("clientStatus").textContent = state.hasClient
      ? "✓ Google Desktop app imported securely."
      : "No Google app imported yet.";
    $("connect").textContent = state.connecting
      ? "Finish sign-in in your browser…"
      : state.connected
        ? "Reconnect YouTube ↗"
        : "Connect YouTube ↗";
    $("connect").disabled = state.connecting || !state.hasClient;
    $("disconnect").hidden = !state.connected;
    $("enable").disabled = !state.connected || state.liveEnabled;
    $("liveStatus").textContent = state.liveEnabled
      ? "✓ Uploads enabled. Review and approve a video in the queue."
      : "Uploads are disabled.";
    $("metrics").replaceChildren();
    for (const [name, statuses] of [
      ["PENDING", ["pending", "ready", "paused"]],
      ["UPLOADING", ["uploading"]],
      ["PROCESSING", ["processing"]],
      ["SCHEDULED", ["scheduled"]],
      ["PUBLISHED / PRIVATE", ["published", "private"]],
      ["NEEDS ATTENTION", ["failed", "needs_review"]],
    ]) {
      const m = el("div", undefined, "metric");
      m.append(
        el(
          "strong",
          String(
            state.items.filter((i) => statuses.includes(i.status)).length,
          ).padStart(2, "0"),
        ),
        el("span", name),
      );
      $("metrics").append(m);
    }
    const batch = state.batches?.find((b) =>
      ["uploading", "scheduling"].includes(b.status),
    );
    $("batchSummary").hidden = !batch;
    if (batch) {
      const items = batch.ids.map((id) => state.items.find((i) => i.id === id));
      const processed = items.filter((i) =>
        ["private", "scheduled", "published"].includes(i?.status),
      ).length;
      $("batchSummary").textContent =
        "Batch: " +
        processed +
        "/" +
        items.length +
        " videos processed. Public posts will be " +
        batch.spacingMinutes +
        " minute(s) apart, starting after the whole batch is ready.";
    }
    renderList();
    if (!dirty && editing) redrawEditor();
  } catch (e) {
    toast(e.message);
  } finally {
    refreshBusy = false;
  }
}
refresh();
setInterval(refresh, 2500);

$("batchButton").onclick = () => $("batchDialog").showModal();
$("closeBatch").onclick = () => $("batchDialog").close();
$("batchForm").onsubmit = async (e) => {
  e.preventDefault();
  const result = await run("batch", {
    spacingMinutes: Number($("batchSpacing").value),
    audience: $("batchAudience").value,
    mediaReviewed: $("batchReview").checked,
  });
  if (result !== false) {
    $("batchDialog").close();
    toast("Batch approved. Resume the queue to start uploads.");
  }
};

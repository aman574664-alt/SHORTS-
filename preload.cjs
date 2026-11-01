const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "api",
  Object.fromEntries(
    [
      "state",
      "folder",
      "addFiles",
      "batch",
      "importClient",
      "connect",
      "disconnect",
      "enable",
      "pause",
      "settings",
      "edit",
      "approve",
      "action",
      "thumbnail",
      "link",
      "videoLink",
      "nextSlot",
      "reschedule",
    ].map((k) => [
      k,
      async (v) => {
        const r = await ipcRenderer.invoke(k, v);
        if (!r.ok) throw Error(r.error);
        return r.data;
      },
    ]),
  ),
);

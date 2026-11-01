const fs = require("node:fs"),
  path = require("node:path");
function boxes(buffer, start = 0, end = buffer.length) {
  const out = [];
  for (let at = start; at + 8 <= end;) {
    let size = buffer.readUInt32BE(at),
      head = 8;
    if (size === 1) {
      if (at + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(at + 8));
      head = 16;
    }
    if (size === 0) size = end - at;
    if (size < head || at + size > end) break;
    out.push({
      type: buffer.toString("ascii", at + 4, at + 8),
      data: at + head,
      end: at + size,
    });
    at += size;
  }
  return out;
}
function inspect(file) {
  const fd = fs.openSync(file, "r");
  try {
    const total = fs.fstatSync(fd).size;
    let at = 0,
      moov;
    while (at + 8 <= total) {
      const h = Buffer.alloc(16);
      fs.readSync(fd, h, 0, 16, at);
      let size = h.readUInt32BE(0),
        head = 8;
      if (size === 1) {
        size = Number(h.readBigUInt64BE(8));
        head = 16;
      }
      if (size === 0) size = total - at;
      if (size < head || at + size > total)
        throw Error("Invalid MP4 structure");
      if (h.toString("ascii", 4, 8) === "moov") {
        if (size > 32 * 1024 * 1024) throw Error("Metadata too large");
        moov = Buffer.alloc(size - head);
        fs.readSync(fd, moov, 0, moov.length, at + head);
        break;
      }
      at += size;
    }
    if (!moov) throw Error("MP4 metadata missing");
    let duration, width, height;
    for (const b of boxes(moov)) {
      if (b.type === "mvhd") {
        const p = b.data;
        if (moov[p] === 1)
          duration =
            Number(moov.readBigUInt64BE(p + 24)) / moov.readUInt32BE(p + 20);
        else duration = moov.readUInt32BE(p + 16) / moov.readUInt32BE(p + 12);
      }
      if (b.type === "trak") {
        const children = boxes(moov, b.data, b.end),
          mdia = children.find((x) => x.type === "mdia");
        if (!mdia) continue;
        const handler = boxes(moov, mdia.data, mdia.end).find(
          (x) => x.type === "hdlr",
        );
        if (
          !handler ||
          moov.toString("ascii", handler.data + 8, handler.data + 12) !== "vide"
        )
          continue;
        const tk = children.find((x) => x.type === "tkhd");
        if (!tk) continue;
        width = moov.readUInt32BE(tk.end - 8) / 65536;
        height = moov.readUInt32BE(tk.end - 4) / 65536;
        const a = moov.readInt32BE(tk.end - 44),
          rot = moov.readInt32BE(tk.end - 40);
        if (a === 0 && Math.abs(rot) === 65536)
          [width, height] = [height, width];
      }
    }
    return {
      durationSeconds: Math.round(duration * 100) / 100,
      width,
      height,
      shortEligible:
        duration > 0 && duration <= 180 && width > 0 && height >= width,
    };
  } finally {
    fs.closeSync(fd);
  }
}
module.exports = { inspect };
if (require.main === module) {
  const dir = process.argv[2];
  for (const name of fs.readdirSync(dir).filter((x) => /\.mp4$/i.test(x))) {
    try {
      console.log(JSON.stringify({ name, ...inspect(path.join(dir, name)) }));
    } catch (e) {
      console.log(JSON.stringify({ name, error: e.message }));
    }
  }
}

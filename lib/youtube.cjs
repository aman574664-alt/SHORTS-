const fs = require("node:fs");
class ApiError extends Error {
  constructor(message, retry = false, uncertain = false) {
    super(message);
    this.retry = retry;
    this.uncertain = uncertain;
  }
}
class YouTube {
  constructor(auth, fetcher = fetch) {
    this.auth = auth;
    this.fetch = fetcher;
  }
  async request(url, options = {}, raw = false) {
    let response;
    try {
      response = await this.fetch(url, {
        ...options,
        headers: {
          ...options.headers,
          Authorization: "Bearer " + (await this.auth.access()),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(90000),
      });
    } catch (e) {
      if (/Connect|authorization|Google/.test(e.message)) throw e;
      throw new ApiError(
        "Connection interrupted. The same upload session will be checked before continuing.",
        true,
      );
    }
    if (response.status === 308) return response;
    if (!response.ok) {
      let reason = "";
      try {
        const data = await response.json();
        reason = data.error?.errors?.[0]?.reason || "";
      } catch {}
      if (response.status === 401) {
        const t = this.auth.vault.get("tokens");
        if (t) this.auth.vault.set("tokens", { ...t, expires: 0 });
        throw new ApiError(
          "Google access needs renewal. Retry, or connect YouTube again.",
          true,
        );
      }
      if (
        ["quotaExceeded", "dailyLimitExceeded", "uploadLimitExceeded"].includes(
          reason,
        )
      )
        throw new ApiError(
          "YouTube quota or channel upload limit reached. Check Google Cloud / YouTube Studio, then retry later.",
        );
      if (
        [404, 410].includes(response.status) &&
        options.method === "PUT" &&
        url.includes("/upload/youtube/")
      )
        throw new ApiError(
          "Upload session expired. Reconcile with YouTube before retrying.",
          false,
          true,
        );
      if (response.status === 429 || response.status >= 500)
        throw new ApiError(
          "YouTube is temporarily unavailable. Retrying with a delay.",
          true,
        );
      throw new ApiError(
        `YouTube rejected this request (${reason || response.status}). Check channel permissions and video details.`,
      );
    }
    return raw ? response : response.json();
  }
  async channel() {
    const r = await this.request(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&mine=true",
    );
    if (!r.items?.length)
      throw Error("No YouTube channel found for this Google account.");
    const c = r.items[0];
    return {
      id: c.id,
      title: c.snippet.title,
      uploads: c.contentDetails.relatedPlaylists.uploads,
    };
  }
  async initiate(item) {
    const response = await this.request(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Length": String(item.size),
          "X-Upload-Content-Type": "application/octet-stream",
        },
        body: JSON.stringify({
          snippet: {
            title: item.title,
            description: item.description,
            categoryId: "22",
            tags: ["ss_" + item.id],
          },
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: item.audience === "yes",
          },
        }),
      },
      true,
    );
    const location = response.headers.get("location");
    this.validateSession(location);
    return location;
  }
  validateSession(url) {
    const u = new URL(url);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "www.googleapis.com" ||
      !u.pathname.startsWith("/upload/youtube/")
    )
      throw Error("YouTube returned an unexpected upload address.");
  }
  async probe(url, size) {
    this.validateSession(url);
    return this.request(
      url,
      {
        method: "PUT",
        headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
      },
      true,
    );
  }
  async chunk(url, item, start) {
    this.validateSession(url);
    const end = Math.min(item.size, start + 8 * 1024 * 1024);
    const f = await fs.promises.open(item.path, "r");
    const bytes = Buffer.alloc(end - start);
    try {
      const read = await f.read(bytes, 0, bytes.length, start);
      if (read.bytesRead !== bytes.length)
        throw Error("Video file changed while uploading.");
    } finally {
      await f.close();
    }
    return this.request(
      url,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Range": `bytes ${start}-${end - 1}/${item.size}`,
        },
        body: bytes,
      },
      true,
    );
  }
  async video(id) {
    const r = await this.request(
      "https://www.googleapis.com/youtube/v3/videos?part=snippet,status,processingDetails&id=" +
        encodeURIComponent(id),
    );
    return r.items?.[0];
  }
  async schedule(item) {
    if (!item.publishConsent || Date.parse(item.at) < Date.now() + 60000)
      throw Error(
        "Posting slot is too close or has passed. Choose a future time; video stays private.",
      );
    return this.request(
      "https://www.googleapis.com/youtube/v3/videos?part=status",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.videoId,
          status: {
            privacyStatus: "private",
            publishAt: item.at,
            selfDeclaredMadeForKids: item.audience === "yes",
          },
        }),
      },
    );
  }
  async keepPrivate(id, audience) {
    return this.request(
      "https://www.googleapis.com/youtube/v3/videos?part=status",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: audience === "yes",
          },
        }),
      },
    );
  }
  async thumbnail(item) {
    return this.request(
      "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media&videoId=" +
        encodeURIComponent(item.videoId),
      {
        method: "POST",
        headers: {
          "Content-Type": /\.png$/i.test(item.thumbnail)
            ? "image/png"
            : "image/jpeg",
        },
        body: await fs.promises.readFile(item.thumbnail),
      },
    );
  }
  async reconcile(item, channel) {
    let page = "";
    for (let n = 0; n < 40; n++) {
      const list = await this.request(
        "https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=" +
          encodeURIComponent(channel.uploads) +
          (page ? "&pageToken=" + encodeURIComponent(page) : ""),
      );
      const ids = (list.items || []).map((x) => x.contentDetails.videoId);
      if (ids.length) {
        const videos = await this.request(
          "https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=" +
            ids.join(","),
        );
        const matches = (videos.items || []).filter((v) =>
          v.snippet?.tags?.includes("ss_" + item.id),
        );
        if (matches.length > 1)
          throw Error(
            "Multiple matching uploads found. Review YouTube Studio.",
          );
        if (matches.length === 1) return matches[0];
      }
      page = list.nextPageToken;
      if (!page) break;
    }
    return null;
  }
}
module.exports = { YouTube, ApiError };

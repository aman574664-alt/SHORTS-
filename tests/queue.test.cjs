const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Queue } = require("../lib/queue.cjs");
const { YouTube, ApiError } = require("../lib/youtube.cjs");
const { Auth } = require("../lib/auth.cjs");
const { Vault, atomic, read } = require("../lib/storage.cjs");
function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "shorts-v2-"));
  const values = {};
  const vault = {
    get: (k) => values[k],
    set: (k, v) => {
      values[k] = v;
    },
  };
  const api = {};
  const q = new Queue(path.join(folder, "library.json"), vault, api);
  q.state.folder = folder;
  return { q, folder, vault, api };
}
async function discover(q, file) {
  await q.scan();
  q.observed.get(file).since = 0;
  await q.scan();
  return q.state.items[0];
}
function approve(q, i) {
  q.state.channel = { id: "channel", uploads: "uploads" };
  i.audience = "no";
  i.shortConfirmed = true;
  q.approve(i);
  q.state.liveEnabled = true;
  q.state.paused = false;
}
const incomplete = (n) => ({
  status: 308,
  headers: new Headers(n ? { range: "bytes=0-" + (n - 1) } : {}),
});
const complete = () => ({
  status: 200,
  json: async () => ({ id: "abcdefghijk" }),
});
test("stable scan, rename and copy share one content identity", async () => {
  const { q, folder } = setup();
  const file = path.join(folder, "one.mp4");
  fs.writeFileSync(file, "video bytes");
  await q.scan();
  assert.equal(q.state.items.length, 0);
  q.observed.get(file).since = 0;
  await q.scan();
  fs.renameSync(file, path.join(folder, "two.mp4"));
  await q.scan();
  q.observed.get(path.join(folder, "two.mp4")).since = 0;
  await q.scan();
  assert.equal(q.state.items.length, 1);
  assert.match(q.state.items[0].path, /two.mp4$/);
  fs.copyFileSync(path.join(folder, "two.mp4"), file);
  await q.scan();
  q.observed.get(file).since = 0;
  await q.scan();
  assert.equal(q.state.items.length, 1);
});
test("six slots respect timezone, one-hour lead and existing reservations", () => {
  const { q } = setup();
  const now = Date.parse("2026-11-01T01:00:00Z");
  assert.equal(q.next(now), "2026-11-01T02:30:00.000Z");
  q.state.items.push({ id: "a", mode: "schedule", at: q.next(now) });
  assert.equal(q.next(now), "2026-11-01T05:00:00.000Z");
  q.settings({ zone: "America/New_York", slots: q.state.slots });
  assert.ok(Date.parse(q.next(now)) > now + 3600000);
});
test("approval requires channel, audience and Shorts confirmation", async () => {
  const { q, folder } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  assert.throws(() => q.approve(i), /Connect/);
  q.state.channel = { id: "a" };
  assert.throws(() => q.approve(i), /Confirm/);
  i.shortConfirmed = true;
  assert.throws(() => q.approve(i), /kids/);
});
test("interrupted final response reconciles the SAME session after restart", async () => {
  const { q, folder, vault, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "bytes");
  const i = await discover(q, p);
  approve(q, i);
  let initiations = 0;
  api.initiate = async () => {
    initiations++;
    return "session";
  };
  api.probe = async () => incomplete(0);
  api.chunk = async () => {
    throw new ApiError("Network interrupted", true);
  };
  await q.step();
  assert.equal(i.status, "uploading");
  const recovered = new Queue(q.file, vault, api);
  recovered.state.items[0].nextAttempt = 0;
  api.probe = async () => complete();
  api.chunk = async () => {
    throw Error("Must not resend a completed video");
  };
  await recovered.step();
  assert.equal(initiations, 1);
  assert.equal(recovered.state.items[0].videoId, "abcdefghijk");
  assert.equal(recovered.state.items[0].status, "processing");
});
test("resuming uses server byte offset, never local estimate", async () => {
  const { q, folder, vault, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "123456789");
  const i = await discover(q, p);
  approve(q, i);
  i.initiated = true;
  i.needsProbe = true;
  i.offset = 8;
  vault.set("session:" + i.id, "session");
  api.probe = async () => incomplete(3);
  api.chunk = async (_, item, start) => {
    assert.equal(start, 3);
    return complete();
  };
  await q.step();
  assert.equal(i.status, "processing");
});
test("uncertain initiation and expired session never initiate another upload", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.initiated = true;
  let starts = 0;
  api.initiate = async () => {
    starts++;
  };
  api.reconcile = async () => null;
  await q.step();
  assert.equal(i.status, "needs_review");
  await q.step();
  assert.equal(starts, 0);
});
test("missed schedule never calls upload or schedule", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.at = "2020-01-01T00:00:00Z";
  api.initiate = async () => assert.fail("must not upload");
  await q.step();
  assert.equal(i.status, "failed");
  assert.match(i.error, /Missed/);
});
test("private upload processes without scheduling and public state comes from YouTube", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.videoId = "abcdefghijk";
  i.status = "processing";
  i.mode = "private";
  api.video = async () => ({
    status: { privacyStatus: "private", uploadStatus: "processed" },
  });
  api.schedule = async () => assert.fail("must stay private");
  await q.step();
  assert.equal(i.status, "private");
  i.status = "scheduled";
  i.nextAttempt = 0;
  api.video = async () => ({
    status: { privacyStatus: "public", uploadStatus: "processed" },
  });
  await q.step();
  assert.equal(i.status, "published");
});
test("schedule is added only after processing with saved consent", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.videoId = "abcdefghijk";
  i.status = "processing";
  api.video = async () => ({
    status: { privacyStatus: "private", uploadStatus: "processed" },
  });
  api.schedule = async (item) => {
    assert.ok(item.publishConsent);
  };
  await q.step();
  assert.equal(i.status, "scheduled");
});
test("scheduled status after a lost update response is recovered without another update", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.videoId = "abcdefghijk";
  i.status = "processing";
  api.video = async () => ({
    status: { privacyStatus: "private", publishAt: i.at },
  });
  api.schedule = async () => assert.fail("already scheduled");
  await q.step();
  assert.equal(i.status, "scheduled");
});
test("source mutation is blocked and pause starts no requests", async () => {
  const { q, folder, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "original");
  const i = await discover(q, p);
  approve(q, i);
  q.state.paused = true;
  api.initiate = async () => assert.fail("must not upload");
  await q.step();
  assert.equal(i.status, "ready");
  fs.writeFileSync(p, "modified");
  q.state.paused = false;
  await q.step();
  assert.equal(i.status, "failed");
  assert.match(i.error, /content changed/);
});
test("API uses private initial upload, rejects past schedule and reports quota safely", async () => {
  let count = 0;
  const vault = { get: () => ({}), set: () => {} };
  const api = new YouTube(
    { access: async () => "secret", vault },
    async (url, opts) => {
      count++;
      assert.equal(JSON.parse(opts.body).status.privacyStatus, "private");
      return new Response("", {
        status: 200,
        headers: {
          location:
            "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=secret",
        },
      });
    },
  );
  await api.initiate({
    id: "hash",
    size: 1,
    title: "Title",
    description: "",
    audience: "no",
  });
  await assert.rejects(
    () => api.schedule({ publishConsent: true, at: "2000-01-01" }),
    /Posting slot/,
  );
  assert.equal(count, 1);
  api.fetch = async () =>
    new Response(
      JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }),
      { status: 403 },
    );
  await assert.rejects(() => api.video("id"), /quota/);
});
test("OAuth accepts only Desktop app configuration", () => {
  const { vault } = setup();
  const auth = new Auth(vault, () => {});
  assert.throws(() => auth.importClient('{"web":{}}'), /Desktop/);
  auth.importClient(
    JSON.stringify({
      installed: {
        client_id: "x.apps.googleusercontent.com",
        client_secret: "local-only",
      },
    }),
  );
  assert.ok(vault.get("client"));
});
test("atomic queue persistence and backup fallback", () => {
  const { q } = setup();
  q.state.folder = "one";
  q.save();
  q.state.folder = "two";
  q.save();
  fs.writeFileSync(q.file, "truncated");
  assert.equal(read(q.file, {}).folder, "one");
});

test("native OAuth flow uses PKCE, rejects wrong callback state and refreshes access", async () => {
  const { vault } = setup();
  let challenge;
  let grants = [];
  const auth = new Auth(
    vault,
    async (address) => {
      const url = new URL(address);
      challenge = url.searchParams.get("code_challenge");
      assert.equal(url.hostname, "accounts.google.com");
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      assert.equal(redirect.hostname, "127.0.0.1");
      redirect.search = new URLSearchParams({
        state: "wrong",
        code: "dummy",
      }).toString();
      assert.equal((await fetch(redirect)).status, 400);
      redirect.search = new URLSearchParams({
        state: url.searchParams.get("state"),
        code: "dummy",
      }).toString();
      assert.equal((await fetch(redirect)).status, 200);
    },
    async (_, opts) => {
      const p = opts.body;
      grants.push(p.get("grant_type"));
      if (p.get("grant_type") === "authorization_code") {
        assert.equal(
          require("node:crypto")
            .createHash("sha256")
            .update(p.get("code_verifier"))
            .digest("base64url"),
          challenge,
        );
      }
      return new Response(
        JSON.stringify({
          access_token: "synthetic-token",
          refresh_token: "synthetic-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    },
  );
  auth.importClient(
    JSON.stringify({
      installed: {
        client_id: "x.apps.googleusercontent.com",
        client_secret: "dummy",
      },
    }),
  );
  await auth.connect();
  assert.equal(await auth.access(), "synthetic-token");
  vault.set("tokens", { ...vault.get("tokens"), expires: 0 });
  assert.equal(await auth.access(), "synthetic-token");
  assert.deepEqual(grants, ["authorization_code", "refresh_token"]);
});
test("expired session reconciles existing upload without a second initiation", async () => {
  const { q, folder, vault, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.initiated = true;
  i.needsProbe = true;
  vault.set("session:" + i.id, "expired");
  api.probe = async () => {
    throw new ApiError("Expired session", false, true);
  };
  api.reconcile = async () => ({ id: "abcdefghijk" });
  api.initiate = async () => assert.fail("must not start another copy");
  await q.step();
  assert.equal(i.status, "processing");
  assert.equal(i.videoId, "abcdefghijk");
});
test("full-byte 308 acknowledgement is probed rather than sending an empty chunk", async () => {
  const { q, folder, vault, api } = setup();
  const p = path.join(folder, "a.mp4");
  fs.writeFileSync(p, "test");
  const i = await discover(q, p);
  approve(q, i);
  i.initiated = true;
  i.needsProbe = true;
  vault.set("session:" + i.id, "session");
  api.probe = async () => incomplete(i.size);
  api.chunk = async () => assert.fail("must not send empty data");
  await q.step();
  assert.equal(i.needsProbe, true);
  assert.ok(i.nextAttempt > Date.now());
});

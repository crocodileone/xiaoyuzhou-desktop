import assert from "node:assert/strict";
import test from "node:test";
import { appHarness, episode, settle } from "./app_harness.mjs";

// 播到指定秒并触发一次 timeupdate（metadata 已就绪）
async function playingAt(h, item, seconds) {
  await h.start(item);
  await settle();
  await h.audio.metadata(600);
  h.audio.currentTime = seconds;
  await h.audio.emit("timeupdate");
}

test("进度上报：30s 节流、pause 强制、body 为 data 包裹数组", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  const a = episode("A");
  h.cache(a);
  await playingAt(h, a, 100);
  await h.audio.emit("timeupdate"); // 30s 内第二次 → 节流
  assert.equal(h.updates().length, 1, "30s 节流内不得重复上报");
  const body = h.updates()[0].payload.body;
  assert.ok(Array.isArray(body.data), "body 必须是 {data:[...]} 包裹（xyz UpdatePlaybackProgressRequestBody 契约）");
  assert.equal(body.data.length, 1);
  const record = body.data[0];
  assert.equal(record.eid, "A");
  assert.equal(record.pid, "p");
  assert.equal(record.progress, 100);
  assert.ok(!Number.isNaN(Date.parse(record.playedAt)), "playedAt 必须是 ISO 时间");
  h.audio.pause(); // pause → 强制上报
  assert.equal(h.updates().length, 2, "pause 必须强制上报");
  assert.equal(h.updates()[1].payload.body.data[0].progress, 100);
});

test("进度上报：<10s 不写、ended 不写 0", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  const a = episode("A");
  h.cache(a);
  await h.start(a);
  await settle();
  await h.audio.metadata(600);
  h.audio.currentTime = 5;
  await h.audio.emit("timeupdate");
  assert.equal(h.updates().length, 0, "播放不足 10s 不得上报");
  h.audio.currentTime = 500;
  h.audio.ended = true;
  h.audio.pause();
  assert.equal(h.updates().length, 0, "ended 不得把进度写回 0");
});

test("标记听过：成功后 30s 内重复播放不重复标记", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  const a = episode("A");
  h.cache(a);
  await h.start(a);
  await settle();
  await h.audio.metadata(600);
  assert.equal(h.played().length, 1, "开播应调用 /played_create 一次");
  assert.equal(h.played()[0].payload.body.eid, "A");
  assert.equal(Object.keys(h.played()[0].payload.body).length, 1, "body 应只有 eid（xyz handler 契约）");
  h.audio.pause();
  await h.audio.play();
  await settle();
  assert.equal(h.played().length, 1, "30s 内重复播放不得重复标记");
});

test("标记听过：失败静默且允许重试", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  h.apiHandler = async (endpoint) => {
    if (endpoint === "/played_create") {
      // 模拟真实网络往返：拒绝必须晚于 play() 的解析链，in-flight 去重才有意义
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("网络错误");
    }
    return { code: 0, data: {} };
  };
  const a = episode("A");
  h.cache(a);
  await h.start(a);
  await settle();
  await h.audio.metadata(600);
  assert.equal(h.played().length, 1, "应尝试一次（失败静默，不打扰播放）");
  h.audio.pause();
  await h.audio.play();
  await settle();
  assert.equal(h.played().length, 2, "失败未记去重表，允许下次重试");
});

test("续播：远端进度大于本地时采用远端", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  h.apiHandler = async (endpoint) => endpoint === "/playback_progress"
    ? { code: 0, data: [{ eid: "B", progress: 300 }] }
    : { code: 0, data: {} };
  const b = episode("B");
  h.cache(b);
  await h.start(b);
  await settle();
  await h.audio.metadata(600);
  assert.equal(h.audio.currentTime, 300);
});

test("续播：本地位置在远端无记录时生效", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  const a = episode("A");
  h.cache(a);
  h.storage["xyzPlaybackPosition:A"] = "420";
  await h.start(a);
  await settle();
  await h.audio.metadata(600);
  assert.equal(h.audio.currentTime, 420);
});

test("续播：距结尾不足 60s 视为听完，从 0 重播", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  h.apiHandler = async (endpoint) => endpoint === "/playback_progress"
    ? { code: 0, data: [{ eid: "C", progress: 590 }] }
    : { code: 0, data: {} };
  const c = episode("C");
  h.cache(c);
  await h.start(c);
  await settle();
  await h.audio.metadata(600);
  assert.equal(h.audio.currentTime, 0, "590/600 应从头重播");
});

test("手动拖条到结尾附近不受 60s 规则影响", async () => {
  const h = appHarness();
  h.state.auth = { accessToken: "test" };
  const a = episode("A");
  h.cache(a);
  await h.start(a);
  await settle();
  await h.audio.metadata(600);
  h.sandbox.setPlayerPosition(h.audio, 590);
  assert.equal(h.audio.currentTime, 590, "seek 必须尊重用户意图");
});

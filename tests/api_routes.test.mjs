import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backgroundSource = readFileSync(path.join(projectRoot, "background.js"), "utf8");
const appSource = readFileSync(path.join(projectRoot, "app.js"), "utf8");
const appHtml = readFileSync(path.join(projectRoot, "app.html"), "utf8");

test("新增端点映射到真实上游路径", () => {
  for (const [short, upstream] of [
    ["/playback_progress", "/v1/playback-progress/list"],
    ["/playback_progress_update", "/v1/playback-progress/update"],
    ["/played_history", "/v1/episode-played/list-history"],
    ["/played_create", "/v1/episode-played/create"],
    ["/inbox", "/v1/inbox/list"],
    ["/unread_count", "/v1/unread-count/get"],
    ["/comment_primary", "/v1/comment/list-primary"],
    ["/comment_thread", "/v1/comment/list-thread"],
    ["/comment_like", "/v1/like/update"]
  ]) {
    assert.match(backgroundSource, new RegExp(`"${short}"\\s*:\\s*"${upstream}"`), `缺少端点映射 ${short} -> ${upstream}`);
  }
});

test("侧栏路由与 routeMeta / 渲染分支一致", () => {
  const htmlRoutes = [...appHtml.matchAll(/data-route="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(new Set(htmlRoutes).size, htmlRoutes.length, "侧栏出现重复路由");
  const routeMetaBlock = appSource.match(/const routeMeta = \{([\s\S]*?)\};/)?.[1] || "";
  const metaRoutes = [...routeMetaBlock.matchAll(/^\s{2}([a-z]+):/gm)].map((match) => match[1]);
  for (const route of htmlRoutes) {
    assert.ok(metaRoutes.includes(route), `routeMeta 缺少 ${route}`);
  }
  for (const route of ["inbox", "history"]) {
    const renderer = `render${route[0].toUpperCase()}${route.slice(1)}Page`;
    assert.match(appSource, new RegExp(`function ${renderer}\\(`), `缺少 ${renderer} 渲染函数`);
    assert.match(appSource, new RegExp(`state\\.route === "${route}"`), `renderRoute 缺少 ${route} 分支`);
  }
});

test("跨设备进度同步接线完整", () => {
  for (const symbol of [
    "fetchRemoteProgress(",
    "syncRemoteProgress(audio, { force: true })",
    "syncRemoteProgress(audio)",
    'data: [{ eid, pid, progress: seconds, playedAt: new Date().toISOString() }]'
  ]) {
    assert.match(appSource, new RegExp(symbol.replace(/[()[\]{}\\.^$*+?|/]/g, (char) => `\\${char}`)), `缺少进度同步接线 ${symbol}`);
  }
});

test("续播临近结尾从 0 重播（拖条 seek 不受影响）", () => {
  for (const symbol of [
    "state.pendingPositionResume",
    "state.pendingPositionResume = true",
    "state.pendingPositionResume = false",
    "seconds >= duration - 60"
  ]) {
    assert.match(appSource, new RegExp(symbol.replace(/[()[\]{}\\.^$*+?|/]/g, (char) => `\\${char}`)), `缺少续播收尾规则接线 ${symbol}`);
  }
});

test("标记听过接线完整（进度上报与收听历史分离）", () => {
  for (const symbol of [
    "async function markEpisodePlayed(",
    'api("/played_create", { eid })',
    "state.playedMarkPending",
    "state.lastPlayedMark",
    "markEpisodePlayed(episode)",
    "markEpisodePlayed(state.current)"
  ]) {
    assert.match(appSource, new RegExp(symbol.replace(/[()[\]{}\\.^$*+?|/]/g, (char) => `\\${char}`)), `缺少标记听过接线 ${symbol}`);
  }
});

test("二维码登录 generation 与 cancel 接线完整", () => {
  for (const symbol of [
    "function cancelQrLogin(",
    "let qrGeneration = 0",
    "let activeQrId = null",
    '"qr-cancel"'
  ]) {
    assert.match(backgroundSource, new RegExp(symbol.replace(/[()[\]{}\\.^$*+?|/]/g, (char) => `\\${char}`)), `缺少二维码防竞态接线 ${symbol}`);
  }
  assert.match(appSource, /send\("qr-cancel"\)/, "缺少 UI 侧 qr-cancel 发送");
});

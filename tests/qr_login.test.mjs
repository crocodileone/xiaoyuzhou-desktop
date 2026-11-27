import assert from "node:assert/strict";
import test from "node:test";
import { backgroundHarness, deferred, settle } from "./app_harness.mjs";

const jsonResponse = (obj, headers = {}) => ({
  ok: true,
  status: 200,
  json: async () => obj,
  headers: { get: (name) => headers[name] ?? null }
});

function installFakeAuthApi(h) {
  let creates = 0;
  const confirmed = new Set();
  h.sandbox.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/auth/qrcode/create")) {
      creates += 1;
      return jsonResponse({ id: "q" + creates, url: "https://h5.xiaoyuzhoufm.com/oauth?qr=1" });
    }
    if (String(url).endsWith("/v1/auth/qrcode/login")) {
      const id = JSON.parse(init.body).id;
      if (confirmed.has(id)) {
        return jsonResponse(
          { status: "CONFIRMED" },
          { "x-jike-access-token": "access-" + id, "x-jike-refresh-token": "refresh-" + id }
        );
      }
      return jsonResponse({ status: "WAITTING" });
    }
    if (String(url).endsWith("/v1/profile/get")) return jsonResponse({ data: { uid: "u1" } });
    throw new Error("unexpected fetch " + url);
  };
  return { confirm: (id) => confirmed.add(id) };
}

test("cancel 作废当前二维码，刷新后新码可用", async () => {
  const h = backgroundHarness();
  installFakeAuthApi(h);
  const first = await h.run("createQrLogin()");
  assert.equal(first.id, "q1");
  await h.sandbox.handleMessage({ type: "qr-cancel" });
  await assert.rejects(
    h.sandbox.handleMessage({ type: "qr-poll", payload: { id: first.id } }),
    /二维码已失效/
  );
  const second = await h.run("createQrLogin()");
  assert.equal(second.id, "q2");
  const waiting = await h.sandbox.handleMessage({ type: "qr-poll", payload: { id: second.id } });
  assert.equal(waiting.status, "WAITTING");
});

test("扫码确认后凭证落盘并返回账号信息", async () => {
  const h = backgroundHarness();
  const { confirm } = installFakeAuthApi(h);
  const first = await h.run("createQrLogin()");
  confirm(first.id);
  const result = await h.sandbox.handleMessage({ type: "qr-poll", payload: { id: first.id } });
  assert.equal(result.status, "CONFIRMED");
  assert.equal(result.auth.accessToken, "access-q1");
  assert.equal(result.auth.refreshToken, "refresh-q1");
  assert.equal(result.auth.deviceId, "test-device");
  assert.equal(result.auth.user.uid, "u1");
  assert.ok(Object.keys(h.stored).length > 0, "凭证应写入 storage");
});

test("取消后到达的确认不落盘（竞态防护）", async () => {
  const h = backgroundHarness();
  const gate = deferred();
  h.sandbox.fetch = async (url, init) => {
    if (String(url).endsWith("/v1/auth/qrcode/create")) {
      return jsonResponse({ id: "q1", url: "https://h5.xiaoyuzhoufm.com/oauth?qr=1" });
    }
    if (String(url).endsWith("/v1/auth/qrcode/login")) {
      await gate.promise;
      return jsonResponse(
        { status: "CONFIRMED" },
        { "x-jike-access-token": "access-q1", "x-jike-refresh-token": "refresh-q1" }
      );
    }
    throw new Error("unexpected fetch " + url);
  };
  const first = await h.run("createQrLogin()");
  const polling = h.sandbox.handleMessage({ type: "qr-poll", payload: { id: first.id } });
  await settle();
  await h.sandbox.handleMessage({ type: "qr-cancel" });
  gate.resolve();
  const result = await polling;
  assert.equal(result.status, "CANCELED");
  assert.equal(Object.keys(h.stored).length, 0, "已取消的登录不得落盘");
});

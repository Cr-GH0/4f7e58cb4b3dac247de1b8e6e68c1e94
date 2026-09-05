import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("renders the real solo/group voice entry without example people or a setup form", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Mimi · English conversation<\/title>/);
  assert.match(html, />Solo</);
  assert.match(html, />Group of 3</);
  assert.match(html, /Start talking/);
  assert.match(html, /History/);
  assert.doesNotMatch(html, /林然|陈曦|周宁|name-[012]|预览场景|模拟语音与对话/);
});

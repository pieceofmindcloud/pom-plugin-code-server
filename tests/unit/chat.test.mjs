import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { injectSeed, ollamaShow, ollamaTags, SEED_SCRIPT, startModelFacade, writeChatModels, writeChatSettings } from "../../runtime/launcher.mjs";

const MODELS = { object: "list", data: [{ id: "Qwen3.8-27B", context_length: 65536 }, { id: "small", top_provider: { context_length: 8192 } }] };

function fakePom() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, body: Buffer.concat(chunks).toString() });
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(MODELS));
      } else if (request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"choices":[{"delta":{"content":"oi"}}]}\n\n');
        response.end("data: [DONE]\n\n");
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/v1` })));
}

test("model lists and capabilities take the Ollama shape", () => {
  assert.deepEqual(ollamaTags(MODELS).models.map((model) => model.name), ["Qwen3.8-27B", "small"]);
  assert.equal(ollamaShow(MODELS, "Qwen3.8-27B").model_info["pom.context_length"], 65536);
  assert.equal(ollamaShow(MODELS, "small").model_info["pom.context_length"], 8192);
  assert.equal(ollamaShow(MODELS, "missing").model_info["pom.context_length"], 32768);
  assert.ok(ollamaShow(MODELS, "small").capabilities.includes("tools"));
});

test("the facade answers like Ollama and forwards chat with the POM key", async () => {
  const pom = await fakePom();
  const facade = await startModelFacade({ base: pom.base, key: "sk-pom-secret" });
  try {
    assert.match(facade.url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{20,}$/);
    assert.equal((await fetch(`${facade.url}/api/version`).then((r) => r.json())).version, "0.12.0");
    const tags = await fetch(`${facade.url}/api/tags`).then((r) => r.json());
    assert.equal(tags.models[0].model, "Qwen3.8-27B");
    const show = await fetch(`${facade.url}/api/show`, { method: "POST", body: JSON.stringify({ model: "Qwen3.8-27B" }) }).then((r) => r.json());
    assert.equal(show.model_info["general.basename"], "Qwen3.8-27B (POM)");
    const chat = await fetch(`${facade.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer from-the-editor" },
      body: JSON.stringify({ model: "Qwen3.8-27B", stream: true, messages: [{ role: "user", content: "oi" }] }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /\[DONE\]/);
    const forwarded = pom.seen.find((entry) => entry.url === "/v1/chat/completions");
    assert.equal(forwarded.auth, "Bearer sk-pom-secret", "the editor's header never reaches the POM");
    assert.match(forwarded.body, /"stream":true/);
    // Without the secret path nothing is served.
    const origin = facade.url.replace(/\/[^/]+$/, "");
    assert.equal((await fetch(`${origin}/api/tags`)).status, 404);
  } finally {
    facade.server.close();
    pom.server.close();
  }
});

test("chat configuration keeps the person's groups and settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-chat-"));
  try {
    mkdirSync(join(dir, "User"), { recursive: true });
    writeFileSync(join(dir, "User", "chatLanguageModels.json"), JSON.stringify([{ name: "Mine", vendor: "ollama", url: "http://x" }, { name: "POM", vendor: "ollama", url: "http://old" }]));
    writeChatModels(dir, "http://127.0.0.1:1/abc");
    const groups = JSON.parse(readFileSync(join(dir, "User", "chatLanguageModels.json"), "utf8"));
    assert.deepEqual(groups.map((group) => [group.name, group.url]), [["Mine", "http://x"], ["POM", "http://127.0.0.1:1/abc"]]);
    writeChatModels(dir, "");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "User", "chatLanguageModels.json"), "utf8")).map((group) => group.name), ["Mine"]);

    writeFileSync(join(dir, "User", "settings.json"), JSON.stringify({ "editor.fontSize": 15 }));
    writeChatSettings(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "User", "settings.json"), "utf8")), { "editor.fontSize": 15, "chat.allowAnonymousAccess": true });
    writeFileSync(join(dir, "User", "settings.json"), JSON.stringify({ "chat.allowAnonymousAccess": false }));
    writeChatSettings(dir);
    assert.equal(JSON.parse(readFileSync(join(dir, "User", "settings.json"), "utf8"))["chat.allowAnonymousAccess"], false);
    const commented = '{\n  // mine\n  "a": 1\n}';
    writeFileSync(join(dir, "User", "settings.json"), commented);
    writeChatSettings(dir);
    assert.equal(readFileSync(join(dir, "User", "settings.json"), "utf8"), commented);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workbench page gets the seed script once, first in head", () => {
  const html = '<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<script nonce="x">a()</script>';
  const injected = injectSeed(html);
  assert.match(injected, /<head>\n\t\t<script src="\.\/_pom\/seed\.js"><\/script>\n\t\t<script src="\.\/_pom\/quiet\.js"><\/script>\n\t\t<script nonce/);
  assert.equal(injectSeed(injected), injected);
  assert.match(SEED_SCRIPT, /github\.copilot-chat/);
  assert.match(SEED_SCRIPT, /builtinChatExtensionEnablementMigration/);
});

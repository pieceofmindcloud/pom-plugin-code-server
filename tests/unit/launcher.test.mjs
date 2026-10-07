import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { prefixedLocation, proxyResponseHeaders, tokenMatches, workbenchFolder, workbenchRedirect } from "../../runtime/launcher.mjs";

const PREFIX = "/api/ui/plugins/code_server/proxy";

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
  });
}

async function waitForStatus(base, token) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await get(`${base}/_pom/status`, { "x-pom-plugin-token": token });
      const status = JSON.parse(response.body);
      if (status.status !== "starting") return status;
    } catch {
      // Wait for the code-server test process to bind.
    }
    await delay(80);
  }
  throw new Error("fake code-server did not become ready");
}

function fakeRelease(root) {
  const codeRoot = join(root, "release");
  mkdirSync(join(codeRoot, "lib"), { recursive: true });
  symlinkSync(process.execPath, join(codeRoot, "lib", "node"));
  writeFileSync(join(codeRoot, "package.json"), JSON.stringify({ main: "index.cjs" }));
  writeFileSync(join(codeRoot, "index.cjs"), `
    const http = require("node:http");
    const crypto = require("node:crypto");
    const portArg = process.argv.find((arg) => arg.startsWith("--bind-addr="));
    const port = Number(portArg.split(":").at(-1));
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
      if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ host: req.headers.host, forwardedHost: req.headers["x-forwarded-host"], prefix: req.headers["x-forwarded-prefix"], folder: process.argv.at(-1) }));
        return;
      }
      if (req.url === "/redirect") { res.writeHead(302, { location: "/login?from=test" }).end(); return; }
      if (req.url === "/_static/serviceWorker.js") {
        res.writeHead(200, { "service-worker-allowed": "/", "content-type": "text/javascript" }).end("");
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" }).end("editor");
    });
    server.on("upgrade", (req, socket) => {
      const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
    });
    server.listen(port, "127.0.0.1");
  `);
  return codeRoot;
}

async function launch(root, codeRoot) {
  const data = join(root, "data");
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const launcher = new URL("../../runtime/launcher.mjs", import.meta.url);
  const child = spawn(process.execPath, [launcher.pathname], {
    env: {
      PATH: process.env.PATH,
      POM_CODE_SERVER_ROOT: codeRoot,
      POM_CODE_SERVER_DATA_DIR: data,
      POM_CODE_SERVER_WORKSPACE: workspace,
      POM_CODE_SERVER_VERSION: "test-version",
      POM_CODE_SERVER_SHELL: "/bin/sh",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const line = await new Promise((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`launcher exited before ready (${code})`)));
  });
  return { child, lines, ready: JSON.parse(line) };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.stdin.end();
  let timer;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => { timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 5000); }),
  ]);
  clearTimeout(timer);
}

test("proxy helpers keep the POM mount prefix on redirects and confine the service worker", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secret", "secret-long"), false);
  assert.equal(tokenMatches(undefined, "secret"), false);
  assert.equal(prefixedLocation("/login?x=1", PREFIX), `${PREFIX}/login?x=1`);
  assert.equal(prefixedLocation(`${PREFIX}/login`, PREFIX), `${PREFIX}/login`);
  assert.equal(prefixedLocation("https://pom.example/login", PREFIX, "pom.example"), `https://pom.example${PREFIX}/login`);
  assert.equal(prefixedLocation("https://docs.example/login", PREFIX, "pom.example"), "https://docs.example/login");
  const headers = proxyResponseHeaders({
    location: "/",
    "service-worker-allowed": "/",
    "set-cookie": ["private=1"],
    "content-type": "text/html",
  }, PREFIX, "pom.example");
  assert.equal(headers.location, `${PREFIX}/`);
  assert.equal(headers["service-worker-allowed"], `${PREFIX}/`);
  assert.equal(headers["set-cookie"], undefined);
});

test("launcher gates HTTP and WebSocket traffic and mounts code-server below the POM prefix", { skip: process.platform === "win32" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pom-code-server-test-"));
  const codeRoot = fakeRelease(root);
  const { child, lines, ready } = await launch(root, codeRoot);
  t.after(async () => {
    await stop(child);
    lines.close();
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal(ready.status, "ready");
  assert.ok(ready.port > 0);
  assert.ok(ready.token.length >= 32);
  const base = `http://127.0.0.1:${ready.port}`;
  const headers = { "x-pom-plugin-token": ready.token };
  const status = await waitForStatus(base, ready.token);
  assert.equal(status.status, "ready");
  assert.equal(status.detail.version, "test-version");

  assert.equal((await get(`${base}/_pom/status`)).status, 401);
  const echoed = await get(`${base}/echo`, {
    ...headers,
    "x-forwarded-host": "pom.example.test:443",
    "x-forwarded-prefix": PREFIX,
  });
  assert.equal(echoed.status, 200);
  assert.deepEqual(JSON.parse(echoed.body), {
    host: "pom.example.test:443",
    forwardedHost: "pom.example.test:443",
    prefix: PREFIX,
    folder: join(root, "workspace"),
  });

  const redirect = await get(`${base}/redirect`, { ...headers, "x-forwarded-prefix": PREFIX });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, `${PREFIX}/login?from=test`);
  const worker = await get(`${base}/_static/serviceWorker.js`, { ...headers, "x-forwarded-prefix": PREFIX });
  assert.equal(worker.headers["service-worker-allowed"], `${PREFIX}/`);

  const socket = await new Promise((resolve, reject) => {
    const connection = http.request({
      host: "127.0.0.1",
      port: ready.port,
      path: "/websocket",
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "x-forwarded-host": "pom.example.test",
        "x-forwarded-prefix": PREFIX,
      },
    });
    connection.on("upgrade", (_response, stream) => resolve(stream));
    connection.on("response", (response) => reject(new Error(`websocket returned ${response.statusCode}`)));
    connection.on("error", reject);
    connection.end();
  });
  socket.destroy();

  const restarted = await fetch(`${base}/_pom/restart`, { method: "POST", headers });
  assert.equal(restarted.status, 202);
  assert.equal((await waitForStatus(base, ready.token)).status, "ready");
});

test("a Windows workspace reaches the workbench as a URI path with its drive", () => {
  assert.equal(workbenchFolder("C:\\Users\\me\\pom_workspace", true), "/c:/Users/me/pom_workspace");
  assert.equal(workbenchFolder("D:\\data\\", true), "/d:/data");
  assert.equal(workbenchFolder("/c:/Users/me", true), "/c:/Users/me");
  assert.equal(workbenchFolder("/home/me/pom_workspace", false), "/home/me/pom_workspace");
});

test("the Windows workbench is redirected to the workspace, keeping other parameters", () => {
  const workspace = "C:\\Users\\me\\pom_workspace";
  assert.equal(workbenchRedirect("/", workspace, true), "?folder=%2Fc%3A%2FUsers%2Fme%2Fpom_workspace");
  assert.equal(workbenchRedirect("/?folder=C%3A%5Cother", workspace, true), "?folder=%2Fc%3A%2Fother");
  assert.equal(workbenchRedirect("/?folder=%2Fc%3A%2Fother", workspace, true), "");
  assert.equal(workbenchRedirect("/?workspace=%2Fc%3A%2Fa.code-workspace", workspace, true), "");
  assert.equal(workbenchRedirect("/?tkn=x", workspace, true), "?tkn=x&folder=%2Fc%3A%2FUsers%2Fme%2Fpom_workspace");
  assert.equal(workbenchRedirect("/", "/home/me/pom_workspace", false), "");
});

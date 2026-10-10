// Runs the official code-server release behind the POM's authenticated plugin proxy.
// The plugin host launches this process with private paths and reads exactly one
// JSON status line from stdout; diagnostics are written only to stderr.

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const env = process.env;
const codeRoot = env.POM_CODE_SERVER_ROOT || "";
const workspace = env.POM_CODE_SERVER_WORKSPACE || "";
const dataDir = env.POM_CODE_SERVER_DATA_DIR || "";
const version = env.POM_CODE_SERVER_VERSION || "unknown";
const windows = process.platform === "win32";
const nodeBin = join(codeRoot, "lib", windows ? "node.exe" : "node");
const token = randomBytes(32).toString("base64url");
const TOKEN_HEADER = "x-pom-plugin-token";
const STATUS_PATH = "/_pom/status";
const RESTART_PATH = "/_pom/restart";
const PREFERENCES_PATH = "/_pom/preferences";
const PREFERENCES_FILE = "preferences.json";
const SEED_PATH = "/_pom/seed.js";
const QUIET_PATH = "/_pom/quiet.js";
const gatewayBase = (env.POM_GATEWAY_BASE_URL || "").replace(/\/+$/, "");
const gatewayKey = env.POM_GATEWAY_API_KEY || "";
/** Name of the provider group the plugin owns in chatLanguageModels.json. */
export const MODEL_GROUP = "POM";

let proxyServer;
let modelFacade;
let modelFacadeUrl = "";
let codeServer;
let codeServerPort;
let restartInProgress = false;
let restartQueued = false;
let preferences = {};
let shuttingDown = false;
let runtimeStatus = { status: "starting" };
let reported = false;

function log(message) {
  process.stderr.write(`code-server: ${message}\n`);
}

function report(value) {
  if (reported) return;
  reported = true;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function prefixedLocation(location, prefix, forwardedHost) {
  if (typeof location !== "string" || !prefix) return location;
  if (/^https?:\/\//i.test(location)) {
    try {
      const url = new URL(location);
      if (forwardedHost && url.host.toLowerCase() !== forwardedHost.toLowerCase()) return location;
      if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) url.pathname = `${prefix}${url.pathname}`;
      return url.toString();
    } catch {
      return location;
    }
  }
  if (!location.startsWith("/") || location.startsWith(`${prefix}/`) || location === prefix) return location;
  return `${prefix}${location}`;
}

export function proxyResponseHeaders(headers, prefix, forwardedHost) {
  const result = { ...headers };
  for (const key of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "set-cookie"]) {
    delete result[key];
  }
  if (result.location) result.location = prefixedLocation(result.location, prefix, forwardedHost);
  if (result["service-worker-allowed"] && prefix) result["service-worker-allowed"] = `${prefix}/`;
  return result;
}

// ---------------------------------------------------------------------------
// POM models in the editor's built-in chat.
//
// VS Code's chat (the built-in Copilot Chat) can use an Ollama server as a
// model provider with only a URL, no secret. The launcher serves that Ollama
// shape on a private loopback path and forwards chat requests to the POM's
// OpenAI-compatible API with the key the POM minted for this plugin: the key
// stays in this process, never in code-server's settings or the browser.

/** Ollama `/api/tags` from an OpenAI `/v1/models` list. */
export function ollamaTags(models) {
  const list = Array.isArray(models?.data) ? models.data : [];
  return {
    models: list
      .filter((model) => typeof model?.id === "string" && model.id)
      .map((model) => ({ name: model.id, model: model.id, details: { family: "pom" } })),
  };
}

/** Ollama `/api/show` for one POM model; tools are always offered. */
export function ollamaShow(models, id) {
  const model = (Array.isArray(models?.data) ? models.data : []).find((entry) => entry?.id === id);
  const context = Number(model?.context_length ?? model?.top_provider?.context_length ?? model?.max_input_tokens) || 32768;
  return {
    model_info: { "general.architecture": "pom", "pom.context_length": context, "general.basename": `${id} (POM)` },
    capabilities: ["completion", "tools"],
  };
}

function readBody(request, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/**
 * Serves the Ollama-shaped facade under `/<secret>`. Returns the base URL the
 * chat is configured with. `base`/`key` are injectable for tests.
 */
export async function startModelFacade({ base = gatewayBase, key = gatewayKey } = {}) {
  const secret = randomBytes(18).toString("base64url");
  const prefix = `/${secret}`;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://facade.invalid");
    if (!url.pathname.startsWith(`${prefix}/`)) {
      sendJson(response, 404, { error: "not found" });
      return;
    }
    const path = url.pathname.slice(prefix.length);
    try {
      if (path === "/api/version" && request.method === "GET") {
        sendJson(response, 200, { version: "0.12.0" });
        return;
      }
      if (path === "/api/tags" && request.method === "GET") {
        const models = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        if (!models.ok) throw new Error(`POM /models returned HTTP ${models.status}`);
        sendJson(response, 200, ollamaTags(await models.json()));
        return;
      }
      if (path === "/api/show" && request.method === "POST") {
        const body = JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}");
        const models = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
        sendJson(response, 200, ollamaShow(models.ok ? await models.json() : {}, String(body.model ?? "")));
        return;
      }
      if (path.startsWith("/v1/")) {
        // `${base}` already ends in `/v1`.
        const target = `${base}${path.slice(3)}${url.search}`;
        const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
        const upstream = await fetch(target, {
          method: request.method,
          headers: { "content-type": request.headers["content-type"] || "application/json", authorization: `Bearer ${key}`, accept: request.headers.accept || "*/*" },
          body,
        });
        const headers = { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" };
        response.writeHead(upstream.status, headers);
        if (!upstream.body) {
          response.end();
          return;
        }
        for await (const chunk of upstream.body) response.write(chunk);
        response.end();
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`model facade ${request.method} ${path}: ${message}`);
      if (!response.headersSent) sendJson(response, 502, { error: message });
      else response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}` };
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Upserts (or, without a URL, removes) the plugin's provider group in the
 * editor's `chatLanguageModels.json`, keeping every group the person added.
 */
export function writeChatModels(userDataDir, url) {
  const directory = join(userDataDir, "User");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "chatLanguageModels.json");
  const current = readJson(file, []);
  const groups = (Array.isArray(current) ? current : []).filter((group) => group?.name !== MODEL_GROUP);
  if (url) groups.push({ name: MODEL_GROUP, vendor: "ollama", url });
  writeFileSync(file, `${JSON.stringify(groups, null, 2)}\n`);
}

/**
 * Lets the built-in chat run without a GitHub account (models come from the
 * POM). Only sets keys the person has not set; a settings file VS Code wrote
 * with comments is left untouched rather than rewritten.
 */
export function writeChatSettings(userDataDir) {
  const directory = join(userDataDir, "User");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8") || "{}");
    } catch {
      log("settings.json is not plain JSON; leaving it as is");
      return;
    }
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return;
  if (settings["chat.allowAnonymousAccess"] !== undefined) return;
  settings["chat.allowAnonymousAccess"] = true;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** VS Code setting values for the POM's two themes (the built-in "Dark Modern" and "Light Modern"). */
export const EDITOR_THEMES = { dark: "Dark Modern", light: "Light Modern" };

/**
 * The preferences the POM sends (`{theme, locale}`), or null when the body is not
 * a JSON object. Unknown themes are ignored; a locale must look like a language tag
 * (VS Code keeps them lowercase, e.g. `pt-br`).
 */
export function parsePreferences(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  if (value.theme === "dark" || value.theme === "light") result.theme = value.theme;
  if (typeof value.locale === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value.locale)) {
    result.locale = value.locale.toLowerCase();
  }
  return result;
}

/**
 * Sets the editor theme to match the POM. VS Code watches `settings.json`, so the
 * change reaches an open editor without a restart. Other settings are kept.
 */
export function writeEditorTheme(userDataDir, theme) {
  const directory = join(userDataDir, "User");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8") || "{}");
    } catch {
      log("settings.json is not plain JSON; the editor theme is not changed");
      return;
    }
  }
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return;
  settings["workbench.colorTheme"] = EDITOR_THEMES[theme];
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function loadPreferences() {
  if (!dataDir) return {};
  try {
    return parsePreferences(readFileSync(join(dataDir, PREFERENCES_FILE), "utf8")) ?? {};
  } catch {
    return {};
  }
}

function savePreferences(value) {
  if (!dataDir) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, PREFERENCES_FILE), `${JSON.stringify(value)}\n`);
}

/** The VS Code language pack for a locale: `pt-br` is `ms-ceintl.vscode-language-pack-pt-br`. */
export function languagePackId(locale) {
  return `ms-ceintl.vscode-language-pack-${locale}`;
}

function validLocalization(entry) {
  if (typeof entry?.languageId !== "string" || !Array.isArray(entry.translations) || entry.translations.length === 0) return false;
  if (!entry.translations.every((item) => typeof item?.id === "string" && typeof item?.path === "string")) return false;
  return !((entry.languageName && typeof entry.languageName !== "string") || (entry.localizedLanguageName && typeof entry.localizedLanguageName !== "string"));
}

/**
 * The `languagepacks.json` that VS Code writes when a language pack is installed
 * (`createLanguagePacksFromExtension`). Without it the server does not use the pack,
 * even when started with `--locale`. `extensions` items are `{identifier, version, dir, manifest}`.
 */
export function languagePacksFromExtensions(extensions) {
  const packs = {};
  for (const { identifier, version, dir, manifest } of extensions) {
    const localizations = manifest?.contributes?.localizations;
    if (!Array.isArray(localizations)) continue;
    for (const entry of localizations) {
      if (!validLocalization(entry)) continue;
      const pack = (packs[entry.languageId] ??= {
        hash: "",
        extensions: [],
        translations: {},
        label: entry.localizedLanguageName ?? entry.languageName,
      });
      const key = identifier.uuid || identifier.id;
      const installed = pack.extensions.find((item) => (item.extensionIdentifier.uuid || item.extensionIdentifier.id) === key);
      if (installed) installed.version = version;
      else pack.extensions.push({ extensionIdentifier: identifier, version });
      for (const translation of entry.translations) pack.translations[translation.id] = join(dir, translation.path);
    }
  }
  for (const pack of Object.values(packs)) {
    const digest = createHash("md5");
    for (const item of pack.extensions) digest.update(item.extensionIdentifier.uuid || item.extensionIdentifier.id).update(item.version);
    pack.hash = digest.digest("hex");
  }
  return packs;
}

/** The extensions VS Code registered in `extensions.json`, with their manifests. */
export function readInstalledExtensions(extensionsDir) {
  let registry;
  try {
    registry = JSON.parse(readFileSync(join(extensionsDir, "extensions.json"), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(registry)) return [];
  const result = [];
  for (const item of registry) {
    if (typeof item?.identifier?.id !== "string" || typeof item.relativeLocation !== "string") continue;
    const dir = join(extensionsDir, item.relativeLocation);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      result.push({ identifier: item.identifier, version: item.version ?? manifest.version, dir, manifest });
    } catch {
      // A missing or unreadable extension is skipped, not fatal.
    }
  }
  return result;
}

/** Writes `languagepacks.json` for the extensions installed in `extensionsDir`. */
export function writeLanguagePacks(extensionsDir, userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  const packs = languagePacksFromExtensions(readInstalledExtensions(extensionsDir));
  writeFileSync(join(userDataDir, "languagepacks.json"), JSON.stringify(packs));
}

/**
 * Makes the display language available: installs the locale's language pack from the
 * extension marketplace once, then writes the pack registry. Resolves false when the
 * pack cannot be made available, and the editor stays in English.
 */
export async function ensureLanguagePack(codeRoot, locale, extensionsDir, userDataDir) {
  const id = languagePackId(locale);
  const installed = readInstalledExtensions(extensionsDir).some((item) => item.identifier.id === id);
  if (!installed) {
    const code = await new Promise((resolve) => {
      const child = spawn(nodeBin, [join(codeRoot, "out", "node", "entry.js"), "--extensions-dir", extensionsDir, "--user-data-dir", userDataDir, "--install-extension", id], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk) => process.stderr.write(`code-server: ${chunk}`));
      child.on("error", () => resolve(-1));
      child.on("exit", (exitCode) => resolve(exitCode));
    });
    if (code !== 0) {
      log(`language pack ${id} could not be installed; the editor stays in English`);
      return false;
    }
  }
  try {
    writeLanguagePacks(extensionsDir, userDataDir);
  } catch (error) {
    log(`could not register language pack ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  return true;
}

/**
 * Runs once per browser before the workbench loads. VS Code disables its
 * built-in chat extension until a GitHub "chat setup" completes and keeps that
 * state in the browser (IndexedDB), out of the server's reach. With POM
 * models no account is needed, so this re-enables the extension and marks the
 * migration as done, then reloads. A person who later disables the extension
 * keeps that choice: the marker makes this run only once.
 */
export const SEED_SCRIPT = `(function () {
  var MARK = "pom.code_server.chat.v1";
  try { if (localStorage.getItem(MARK)) return; } catch (e) { return; }
  if (window.stop) window.stop();
  function done() { try { localStorage.setItem(MARK, "1"); } catch (e) {} location.reload(); }
  var open = indexedDB.open("vscode-web-state-db-global");
  open.onupgradeneeded = function () { open.result.createObjectStore("ItemTable"); };
  open.onerror = done;
  open.onsuccess = function () {
    var db = open.result;
    if (!db.objectStoreNames.contains("ItemTable")) { db.close(); done(); return; }
    var tx = db.transaction("ItemTable", "readwrite");
    var store = tx.objectStore("ItemTable");
    var read = store.get("extensionsIdentifiers/disabled");
    read.onsuccess = function () {
      var list = [];
      try { list = JSON.parse(read.result || "[]"); } catch (e) {}
      if (!Array.isArray(list)) list = [];
      list = list.filter(function (entry) { return String(entry && entry.id).toLowerCase() !== "github.copilot-chat"; });
      store.put(JSON.stringify(list), "extensionsIdentifiers/disabled");
      store.put("true", "builtinChatExtensionEnablementMigration");
    };
    tx.oncomplete = function () { db.close(); done(); };
    tx.onerror = function () { db.close(); done(); };
  };
})();
`;

/** Adds the seed script as the first element of the workbench `<head>`. */
/**
 * The folder as the workbench expects it in `?folder=`. VS Code reads the value as
 * the path of a remote URI, so a Windows path must be `/c:/Users/...`: given
 * `C:\Users\...`, the browser parsed `C:` as a URI scheme and opened
 * `\Users\...` without its drive, which the editor then failed to open.
 */
export function workbenchFolder(path, isWindows) {
  if (!isWindows) return path;
  const drive = /^([A-Za-z]):[\\/]*(.*)$/.exec(path);
  if (!drive) return path.replace(/\\/g, "/");
  const rest = drive[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return `/${drive[1].toLowerCase()}:/${rest}`;
}

/**
 * Where to send a workbench request so it opens `folder`, or "" to serve it as is.
 * A request that names nothing gets the workspace; a `folder` still in drive form
 * (`C:\...`) is rewritten. Both redirect with a relative query, so the POM prefix
 * in front of the plugin stays intact.
 */
export function workbenchRedirect(url, folder, isWindows) {
  if (!isWindows || !folder) return "";
  const parsed = new URL(url, "http://code-server.invalid");
  const params = parsed.searchParams;
  const current = params.get("folder");
  if (current === null) {
    if (params.has("workspace") || params.has("ew")) return "";
    params.set("folder", workbenchFolder(folder, true));
  } else {
    const fixed = workbenchFolder(current, true);
    if (fixed === current) return "";
    params.set("folder", fixed);
  }
  return `?${params.toString()}`;
}

/**
 * Acknowledges code-server's "accessed in an insecure context" notice. The page
 * is served over plain HTTP on the POM's address, so the notice is accurate; the
 * script only presses its "I understand" button. `isSecureContext` is left as it is.
 */
export const QUIET_SCRIPT = `(function () {
  var TEXT = "is being accessed in an insecure context";
  function acknowledge() {
    var toasts = document.querySelectorAll(".notification-toast");
    for (var i = 0; i < toasts.length; i++) {
      if (toasts[i].textContent.indexOf(TEXT) === -1) continue;
      var buttons = toasts[i].querySelectorAll("a, button");
      for (var j = 0; j < buttons.length; j++) {
        if (buttons[j].textContent.trim() === "I understand") { buttons[j].click(); return; }
      }
    }
  }
  new MutationObserver(acknowledge).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

export function injectSeed(html) {
  const tag = '<script src="./_pom/seed.js"></script>\n\t\t<script src="./_pom/quiet.js"></script>';
  if (html.includes(tag)) return html;
  return html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}\n\t\t${tag}`);
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

function serverEnvironment() {
  const output = {};
  const safe = ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
  for (const name of safe) if (env[name] !== undefined) output[name] = env[name];
  const delimiter = windows ? ";" : ":";
  const systemPath = env.PATH || (windows ? "C:\\Windows\\System32" : "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  output.PATH = [join(codeRoot, "bin"), join(codeRoot, "lib"), systemPath].join(delimiter);
  output.HOME = join(dataDir, "home");
  output.USERPROFILE = output.HOME;
  output.XDG_CONFIG_HOME = join(output.HOME, ".config");
  output.XDG_DATA_HOME = join(output.HOME, ".local", "share");
  output.TERM = "xterm-256color";
  output.COLORTERM = "truecolor";
  output.CODE_SERVER_DISABLE_TELEMETRY = "1";
  if (!windows) output.SHELL = env.POM_CODE_SERVER_SHELL || "/bin/bash";
  return output;
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function stopCodeServer() {
  const child = codeServer;
  codeServer = undefined;
  codeServerPort = undefined;
  if (!child || child.exitCode !== null) return;
  log("stopping current code-server process");
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    waitForExit(child).then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 4000)),
  ]);
  if (timedOut && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([waitForExit(child), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  log("code-server process stopped");
}

async function startCodeServer() {
  log("starting bundled code-server");
  if (!codeRoot || !workspace || !dataDir || !existsSync(nodeBin)) {
    throw new Error("the bundled code-server runtime is incomplete");
  }
  for (const directory of [workspace, dataDir, join(dataDir, "home"), join(dataDir, "user-data"), join(dataDir, "extensions")]) {
    mkdirSync(directory, { recursive: true });
  }

  const port = await freePort();
  const userData = join(dataDir, "user-data");
  const extensionsDir = join(dataDir, "extensions");
  const languageReady = preferences.locale && preferences.locale !== "en"
    ? await ensureLanguagePack(codeRoot, preferences.locale, extensionsDir, userData)
    : false;
  try {
    writeChatModels(userData, modelFacadeUrl);
    if (modelFacadeUrl) writeChatSettings(userData);
    if (preferences.theme) writeEditorTheme(userData, preferences.theme);
  } catch (error) {
    log(`could not configure POM models for the chat: ${error instanceof Error ? error.message : String(error)}`);
  }
  const args = [
    codeRoot,
    `--bind-addr=127.0.0.1:${port}`,
    "--auth=none",
    "--disable-telemetry",
    "--disable-update-check",
    "--disable-workspace-trust",
    "--user-data-dir",
    userData,
    "--extensions-dir",
    extensionsDir,
    "--ignore-last-opened",
  ];
  // The display language is read when code-server starts, so a change restarts it.
  if (languageReady) args.push(`--locale=${preferences.locale}`);
  // On Windows the proxy opens the workspace through `?folder=` in URI form
  // (`workbenchRedirect`); code-server's own redirect would carry `C:\...`.
  if (!windows) args.push(workspace);
  const child = spawn(nodeBin, args, {
    cwd: workspace,
    env: serverEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  codeServer = child;
  codeServerPort = port;
  child.stdout.on("data", (chunk) => process.stderr.write(`code-server: ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`code-server: ${chunk}`));
  child.on("error", (error) => {
    if (codeServer === child) runtimeStatus = { status: "error", error: error.message };
  });
  child.on("exit", (code, signal) => {
    if (codeServer === child && !shuttingDown) {
      codeServer = undefined;
      codeServerPort = undefined;
      runtimeStatus = { status: "error", error: `code-server exited (${code ?? signal ?? "unknown"})` };
      log(runtimeStatus.error);
    }
  });

  const deadline = Date.now() + 120_000;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`code-server exited before becoming ready (${child.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        runtimeStatus = { status: "ready", detail: { version } };
        log(`v${version} ready on 127.0.0.1:${port}`);
        return;
      }
      lastError = `health check returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`code-server did not become ready: ${lastError}`);
}

async function restartCodeServer() {
  if (shuttingDown) return;
  if (restartInProgress) {
    restartQueued = true;
    return;
  }
  restartInProgress = true;
  log("code-server restart requested");
  runtimeStatus = { status: "starting" };
  await stopCodeServer();
  log("previous code-server process stopped");
  try {
    await startCodeServer();
  } catch (error) {
    runtimeStatus = { status: "error", error: error instanceof Error ? error.message : String(error) };
    log(runtimeStatus.error);
    await stopCodeServer();
  } finally {
    restartInProgress = false;
  }
  if (restartQueued && !shuttingDown) {
    restartQueued = false;
    await restartCodeServer();
  }
}

function authorized(request) {
  return tokenMatches(request.headers[TOKEN_HEADER], token);
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function outgoingHeaders(incoming, proxyPort, isUpgrade = false) {
  const headers = { ...incoming };
  delete headers.host;
  delete headers[TOKEN_HEADER];
  if (!isUpgrade) {
    for (const name of ["connection", "keep-alive", "proxy-connection", "upgrade", "transfer-encoding"]) delete headers[name];
  } else {
    headers.connection = "Upgrade";
    headers.upgrade = incoming.upgrade || "websocket";
  }
  headers.host = incoming["x-forwarded-host"] || `127.0.0.1:${proxyPort}`;
  return headers;
}

function proxyHttp(request, response, proxyPort) {
  if (!codeServer || codeServer.exitCode !== null || !codeServerPort) {
    sendJson(response, 503, runtimeStatus);
    return;
  }
  const prefix = typeof request.headers["x-forwarded-prefix"] === "string" ? request.headers["x-forwarded-prefix"] : "";
  const pathname = new URL(request.url, "http://code-server.invalid").pathname;
  // The workbench page gets the one-time chat seed; everything else streams.
  const workbenchPage = request.method === "GET" && pathname === "/" && /text\/html/.test(request.headers.accept || "");
  const redirect = workbenchPage ? workbenchRedirect(request.url, workspace, windows) : "";
  if (redirect) {
    response.writeHead(302, { location: redirect, "cache-control": "no-store" });
    response.end();
    return;
  }
  const headers = outgoingHeaders(request.headers, proxyPort);
  if (workbenchPage) delete headers["accept-encoding"];
  const outbound = http.request({
    hostname: "127.0.0.1",
    port: codeServerPort,
    method: request.method,
    path: request.url,
    headers,
  }, (upstream) => {
    const responseHeaders = proxyResponseHeaders(upstream.headers, prefix, request.headers["x-forwarded-host"]);
    const isHtml = /text\/html/.test(upstream.headers["content-type"] || "") && !upstream.headers["content-encoding"];
    if (!workbenchPage || !isHtml || upstream.statusCode !== 200) {
      response.writeHead(upstream.statusCode || 502, responseHeaders);
      upstream.pipe(response);
      return;
    }
    const chunks = [];
    upstream.on("data", (chunk) => chunks.push(chunk));
    upstream.on("end", () => {
      const body = Buffer.from(injectSeed(Buffer.concat(chunks).toString("utf8")));
      responseHeaders["content-length"] = String(body.length);
      response.writeHead(200, responseHeaders);
      response.end(body);
    });
    upstream.on("error", (error) => response.destroy(error));
  });
  outbound.on("error", (error) => {
    log(`proxy ${request.method} ${request.url}: ${error.message}`);
    if (!response.headersSent) sendJson(response, 502, { error: "code-server is unavailable" });
    else response.destroy(error);
  });
  request.on("aborted", () => outbound.destroy());
  request.pipe(outbound);
}

function websocketResponseHead(response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name.toLowerCase() !== "set-cookie") lines.push(`${name}: ${value}`);
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

function proxyWebSocket(request, clientSocket, head, proxyPort) {
  if (!authorized(request) || !codeServer || codeServer.exitCode !== null || !codeServerPort) {
    clientSocket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
    return;
  }
  const outbound = http.request({
    hostname: "127.0.0.1",
    port: codeServerPort,
    method: request.method,
    path: request.url,
    headers: outgoingHeaders(request.headers, proxyPort, true),
  });
  outbound.on("upgrade", (upstream, upstreamSocket, upstreamHead) => {
    if (upstream.statusCode !== 101) {
      clientSocket.end(websocketResponseHead(upstream));
      upstreamSocket.destroy();
      return;
    }
    clientSocket.write(websocketResponseHead(upstream));
    if (upstreamHead.length) clientSocket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.pipe(clientSocket);
    clientSocket.on("error", () => upstreamSocket.destroy());
    clientSocket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("error", () => clientSocket.destroy());
    upstreamSocket.on("close", () => clientSocket.destroy());
  });
  outbound.on("response", (upstream) => {
    clientSocket.end(websocketResponseHead(upstream));
  });
  outbound.on("error", (error) => {
    log(`websocket ${request.url}: ${error.message}`);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
  });
  outbound.end();
}

function startProxyServer() {
  const server = http.createServer((request, response) => {
    if (!authorized(request)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const pathname = new URL(request.url, "http://code-server.invalid").pathname;
    if (pathname === STATUS_PATH && request.method === "GET") {
      sendJson(response, 200, runtimeStatus);
      return;
    }
    if ((pathname === SEED_PATH || pathname === QUIET_PATH) && request.method === "GET") {
      const body = Buffer.from(pathname === QUIET_PATH ? QUIET_SCRIPT : SEED_SCRIPT);
      response.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(body);
      return;
    }
    if (pathname === PREFERENCES_PATH && request.method === "POST") {
      readBody(request, 16 * 1024)
        .then((body) => {
          const next = parsePreferences(body.toString("utf8"));
          if (!next) {
            sendJson(response, 400, { error: "invalid preferences" });
            return;
          }
          const localeChanged = next.locale !== undefined && next.locale !== preferences.locale;
          preferences = { ...preferences, ...next };
          savePreferences(preferences);
          if (preferences.theme) {
            try {
              writeEditorTheme(join(dataDir, "user-data"), preferences.theme);
            } catch (error) {
              log(`could not set the editor theme: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          if (localeChanged) {
            sendJson(response, 202, { status: "restarting" });
            void restartCodeServer();
          } else {
            sendJson(response, 200, { status: runtimeStatus.status });
          }
        })
        .catch(() => sendJson(response, 400, { error: "invalid preferences" }));
      return;
    }
    if (pathname === RESTART_PATH && request.method === "POST") {
      sendJson(response, 202, { status: "starting" });
      void restartCodeServer();
      return;
    }
    proxyHttp(request, response, server.address().port);
  });
  server.on("upgrade", (request, socket, head) => proxyWebSocket(request, socket, head, server.address().port));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  runtimeStatus = { status: "stopping" };
  if (proxyServer) proxyServer.close();
  if (modelFacade) modelFacade.server.close();
  await stopCodeServer();
  process.exit(code);
}

async function main() {
  if (gatewayBase && gatewayKey) {
    try {
      modelFacade = await startModelFacade();
      modelFacadeUrl = modelFacade.url;
      log("POM models available to the editor chat");
    } catch (error) {
      log(`model facade unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  preferences = loadPreferences();
  proxyServer = await startProxyServer();
  report({ status: "ready", port: proxyServer.address().port, token, detail: { version } });
  void restartCodeServer();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdin.on("end", () => void shutdown(0));
  process.stdin.on("error", () => void shutdown(0));
  process.stdin.resume();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void shutdown(0));
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    report({ status: "error", error: message });
    void shutdown(1);
  });
}

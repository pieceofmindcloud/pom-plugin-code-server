import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { languagePackId, languagePacksFromExtensions, writeLanguagePacks } from "../../runtime/launcher.mjs";

const manifest = {
  contributes: {
    localizations: [
      {
        languageId: "pt-br",
        languageName: "Portuguese (Brazil)",
        localizedLanguageName: "português (Brasil)",
        translations: [{ id: "vscode", path: "./translations/main.i18n.json" }],
      },
    ],
  },
};

test("the pack id follows the marketplace naming", () => {
  assert.equal(languagePackId("pt-br"), "ms-ceintl.vscode-language-pack-pt-br");
});

test("the registry lists the language pack the way VS Code writes it", () => {
  const packs = languagePacksFromExtensions([
    { identifier: { id: "ms-ceintl.vscode-language-pack-pt-br" }, version: "1.131.0", dir: "/ext/pt", manifest },
    { identifier: { id: "other.extension" }, version: "1.0.0", dir: "/ext/other", manifest: { contributes: {} } },
  ]);
  assert.deepEqual(Object.keys(packs), ["pt-br"]);
  assert.equal(packs["pt-br"].label, "português (Brasil)");
  assert.deepEqual(packs["pt-br"].extensions, [{ extensionIdentifier: { id: "ms-ceintl.vscode-language-pack-pt-br" }, version: "1.131.0" }]);
  assert.equal(packs["pt-br"].translations.vscode, join("/ext/pt", "./translations/main.i18n.json"));
  assert.match(packs["pt-br"].hash, /^[0-9a-f]{32}$/);
});

test("an invalid localization is ignored", () => {
  const packs = languagePacksFromExtensions([
    { identifier: { id: "bad" }, version: "1", dir: "/ext/bad", manifest: { contributes: { localizations: [{ languageId: "xx", translations: [] }] } } },
  ]);
  assert.deepEqual(packs, {});
});

test("writing the registry reads extensions.json and the manifests on disk", () => {
  const root = mkdtempSync(join(tmpdir(), "cs-lang-"));
  try {
    const extensions = join(root, "extensions");
    const folder = join(extensions, "ms-ceintl.vscode-language-pack-pt-br-1.131.0-universal");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "package.json"), JSON.stringify({ version: "1.131.0", ...manifest }));
    writeFileSync(join(extensions, "extensions.json"), JSON.stringify([
      { identifier: { id: "ms-ceintl.vscode-language-pack-pt-br" }, version: "1.131.0", relativeLocation: "ms-ceintl.vscode-language-pack-pt-br-1.131.0-universal" },
    ]));
    const userData = join(root, "user-data");
    writeLanguagePacks(extensions, userData);
    const written = JSON.parse(readFileSync(join(userData, "languagepacks.json"), "utf8"));
    assert.equal(written["pt-br"].extensions[0].version, "1.131.0");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

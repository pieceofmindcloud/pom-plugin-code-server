import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parsePreferences, writeEditorTheme } from "../../runtime/launcher.mjs";

test("preferences keep only a known theme and a language tag, lowercased", () => {
  assert.deepEqual(parsePreferences('{"theme":"light","locale":"pt-BR"}'), { theme: "light", locale: "pt-br" });
  assert.deepEqual(parsePreferences('{"theme":"blue","locale":"../etc"}'), {});
  assert.deepEqual(parsePreferences('{"locale":"en"}'), { locale: "en" });
});

test("preferences refuse anything that is not a JSON object", () => {
  assert.equal(parsePreferences("not json"), null);
  assert.equal(parsePreferences("[1,2]"), null);
  assert.equal(parsePreferences("null"), null);
});

test("the editor theme follows the POM and keeps the other settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-theme-"));
  try {
    const user = join(dir, "user-data", "User");
    mkdirSync(user, { recursive: true });
    writeFileSync(join(user, "settings.json"), '{"editor.fontSize":14}');
    writeEditorTheme(join(dir, "user-data"), "light");
    let settings = JSON.parse(readFileSync(join(user, "settings.json"), "utf8"));
    assert.equal(settings["workbench.colorTheme"], "Light Modern");
    assert.equal(settings["editor.fontSize"], 14);
    writeEditorTheme(join(dir, "user-data"), "dark");
    settings = JSON.parse(readFileSync(join(user, "settings.json"), "utf8"));
    assert.equal(settings["workbench.colorTheme"], "Dark Modern");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn text(path: &str) -> String {
    fs::read_to_string(root().join(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

fn json(path: &str) -> Value {
    serde_json::from_str(&text(path)).unwrap_or_else(|error| panic!("{path}: {error}"))
}

#[test]
fn manifest_registers_an_admin_only_full_bleed_code_server_editor() {
    let manifest = json("ui/manifest.json");
    assert_eq!(manifest["schema"], "pom-plugin-ui/v1");
    assert_eq!(manifest["plugin_code"], "code_server");
    assert_eq!(manifest["menu"][0]["id"], "editor");
    assert_eq!(manifest["menu"][0]["to"], "/editor");
    assert_eq!(manifest["menu"][0]["roles"], serde_json::json!(["admin"]));
    assert_eq!(manifest["routes"][0]["path"], "/editor");
    assert_eq!(manifest["routes"][0]["screen"], "editor");
    assert_eq!(manifest["routes"][0]["full_bleed"], true);
    assert_eq!(manifest["routes"][0]["roles"], serde_json::json!(["admin"]));
    assert_eq!(manifest["screens"]["editor"]["module"], "ui/screens.js");
    assert_eq!(manifest["screens"]["editor"]["export"], "editor");
    assert_eq!(
        manifest["documentation"]["guides"][0]["asset"],
        "docs/README.md"
    );
}

#[test]
fn manifest_assets_and_locales_are_complete() {
    let manifest = json("ui/manifest.json");
    let assets: BTreeSet<_> = manifest["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| asset.as_str().unwrap())
        .collect();
    assert_eq!(
        assets,
        BTreeSet::from([
            "ui/screens.js",
            "ui/plugin.css",
            "ui/icon.png",
            "i18n/en.json",
            "i18n/pt-BR.json",
            "docs/README.md",
        ])
    );
    let editor = text("ui/src/screens/Editor.tsx");
    assert!(editor.contains("/_pom/status"));
    assert!(editor.contains("/_pom/restart"));
    assert!(editor.contains("src={`${PROXY}/`}"));
    assert!(fs::read(root().join("ui/icon.png"))
        .unwrap()
        .starts_with(b"\x89PNG\r\n\x1a\n"));

    let en = json("i18n/en.json");
    let pt = json("i18n/pt-BR.json");
    let en_keys: BTreeSet<_> = en.as_object().unwrap().keys().cloned().collect();
    let pt_keys: BTreeSet<_> = pt.as_object().unwrap().keys().cloned().collect();
    assert_eq!(en_keys, pt_keys);
    let source = text("ui/src/screens/Editor.tsx");
    for key in en_keys {
        assert!(
            source.contains(&format!("t(\"{key}\"")),
            "screen does not use translation {key}"
        );
    }
    if std::env::var_os("POM_UI_REQUIRE_DIST").is_some() {
        for path in [
            "ui/dist/screens.js",
            "ui/dist/plugin.css",
            "ui/dist/i18n/en.json",
            "ui/dist/i18n/pt-BR.json",
        ] {
            assert!(root().join(path).is_file(), "missing built asset {path}");
        }
    }
}

#[test]
fn screenshot_gallery_points_to_the_supplied_repository_images() {
    let manifest = json("ui/manifest.json");
    let screenshots = manifest["screenshots"].as_array().expect("screenshots");
    assert_eq!(screenshots.len(), 2);
    let assets: BTreeSet<_> = manifest["assets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|asset| asset.as_str().unwrap())
        .collect();
    for image in screenshots {
        let path = image.as_str().unwrap();
        assert!(path.starts_with("docs/screenshots/") && path.ends_with(".png"));
        assert!(!assets.contains(path));
        assert!(fs::read(root().join(path))
            .unwrap()
            .starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}

#[test]
fn release_contract_is_namespaced_and_published_as_a_public_github_plugin() {
    let release = json("release/manifest.json");
    assert_eq!(release["schema"], 1);
    assert_eq!(release["plugin_code"], "code_server");
    assert_eq!(release["plugin_abi"], 1);
    assert_eq!(
        release["feature_set"],
        serde_json::json!(["code_server.editor"])
    );

    let package = text("scripts/package.sh");
    assert!(package.contains("pom-plugin-${platform}.json"));
    assert!(package.contains("  \"code_server_version\": \"${resolved_code_server}\""));
    assert!(package.contains(r#"'($contract[0]) + {release_id:$release_id, version:$version, os:$os, arch:$arch, asset:$asset, sha256:$sha256, size:$size}'"#));
    let workflow = text(".github/workflows/publish-release.yml");
    assert!(workflow.contains("softprops/action-gh-release"));
    // Stable releases also go to the license server, POM's fallback.
    assert!(workflow.contains("license-server") && workflow.contains("POM_RELEASE_TOKEN"));
}

#[test]
fn native_plugin_uses_the_host_abi_and_authenticated_upstream_contract() {
    let lib = text("src/lib.rs");
    for operation in [
        "host.configure",
        "host.event",
        "ui.upstream",
        "ui.runtime.json",
        "ui.manifest",
        "ui.asset",
    ] {
        assert!(
            lib.contains(&format!("\"{operation}\"")),
            "missing query operation {operation}"
        );
    }
    assert!(lib.contains("pom_code_server_plugin_v1"));
    let supervisor = text("src/supervisor.rs");
    // The node verifies the downloaded release against the pinned digest.
    assert!(supervisor.contains("code-server archive checksum mismatch"));
    assert!(supervisor.contains("POM_GATEWAY_API_KEY"));
    assert!(!supervisor.contains("x-pom-plugin-token"));
    let launcher = text("runtime/launcher.mjs");
    assert!(launcher.contains("x-pom-plugin-token"));
    assert!(launcher.contains("--auth=none"));
    assert!(launcher.contains("127.0.0.1"));
    assert!(launcher.contains("stdio: [\"ignore\", \"pipe\", \"pipe\"]"));
    assert!(!launcher.contains("...process.env"));
}

#[test]
fn package_build_pins_the_official_release_digest_without_embedding_it() {
    let fetch = text("scripts/fetch-runtime.sh");
    assert!(fetch.contains(".digest"));
    assert!(fetch.contains("SHA-256 mismatch"));
    assert!(fetch.contains("--metadata-only"));
    let build = text("scripts/build.sh");
    assert!(build.contains("--metadata-only"));
    assert!(build.contains("CODE_SERVER_URL=\"$url\""));
    assert!(build.contains("CODE_SERVER_SHA256=\"$checksum\""));
    assert!(!build.contains("CODE_SERVER_ARCHIVE"));
    assert!(!text("build.rs").contains("include_bytes!({archive"));
    assert!(root().join("scripts/package.sh").is_file());
    assert!(root().join("runtime/launcher.mjs").is_file());
    assert!(root().join("AGENTS.md").is_file());
}

import { useCallback, useEffect, useRef, useState } from "react";
import { hostVersion, loader, onLoaderRetry, pluginRpc, usePluginI18n } from "../host/runtime";
import { useScreenReady } from "../host/ready";

const PROXY = "/api/ui/plugins/code_server/proxy";

type RuntimeStatus = {
  status?: string;
  error?: string;
  detail?: { version?: string; downloaded?: number; total?: number };
};

const megabytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(0);

/** The POM's theme, read from the page and followed while it changes. */
function usePomTheme(): "light" | "dark" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export function Editor() {
  const { t, locale } = usePluginI18n();
  const theme = usePomTheme();
  const [state, setState] = useState<"starting" | "ready" | "error">("starting");
  const [message, setMessage] = useState("");
  const [canRestart, setCanRestart] = useState(false);
  const [install, setInstall] = useState<{ downloaded: number; total: number; version: string } | null>(null);
  const [reload, setReload] = useState(0);
  const startedAt = useRef(Date.now());
  const appliedTheme = useRef<"light" | "dark" | null>(null);
  // POM's loader covers the screen while the runtime downloads and the editor starts (host version 7).
  const covered = hostVersion() >= 7;
  // A download ran in this mount: the end is a success, not a plain opening.
  const installed = useRef(false);

  const poll = useCallback(async (signal: AbortSignal) => {
    // While the runtime downloads there is no editor to proxy to: ask the
    // plugin itself for progress (POM plugin RPC).
    const rpc = pluginRpc();
    if (rpc) {
      try {
        const own = await rpc<RuntimeStatus>("runtime.status");
        if (own.status === "installing") {
          setState("starting");
          setInstall({ downloaded: own.detail?.downloaded ?? 0, total: own.detail?.total ?? 0, version: own.detail?.version ?? "" });
          startedAt.current = Date.now();
          return;
        }
        setInstall(null);
        if (own.status === "error") {
          setState("error");
          setMessage(own.error ?? t("failedDetail"));
          setCanRestart(true);
          return;
        }
      } catch {
        // Fall back to the editor proxy below.
      }
    }
    try {
      const response = await fetch(`${PROXY}/_pom/status`, { cache: "no-store", signal });
      if (!response.ok) {
        if (Date.now() - startedAt.current > 300_000) {
          setState("error");
          setMessage(t("unavailableDetail"));
          setCanRestart(false);
        }
        return;
      }
      const body = (await response.json()) as RuntimeStatus;
      if (body.status === "ready") {
        setState("ready");
        setCanRestart(false);
        setMessage(body.detail?.version ? t("version", { version: body.detail.version }) : "");
      } else if (body.status === "error") {
        setState("error");
        setMessage(body.error ?? t("failedDetail"));
        setCanRestart(true);
      } else if (Date.now() - startedAt.current > 300_000) {
        setState("error");
        setMessage(t("unavailableDetail"));
        setCanRestart(true);
      } else {
        setState("starting");
      }
    } catch {
      // The node proxy reports 503 until host.configure finishes launching the IDE.
    }
  }, [t]);

  // The POM's theme and language follow into the editor. A theme change applies
  // at once; a language change restarts the editor, which reads it when it starts.
  useEffect(() => {
    let cancelled = false;
    void fetch(`${PROXY}/_pom/preferences`, {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme, locale }),
    })
      .then((response) => {
        if (cancelled || !response.ok) return;
        const previous = appliedTheme.current;
        appliedTheme.current = theme;
        if (response.status === 202) {
          // A language change restarts the editor: wait for it to come back.
          setState("starting");
          setCanRestart(false);
          setMessage("");
          startedAt.current = Date.now();
          setReload((value) => value + 1);
        } else if (previous !== null && previous !== theme) {
          // The workbench reads its theme when it loads: reload the frame.
          setReload((value) => value + 1);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [theme, locale]);

  useEffect(() => {
    const controller = new AbortController();
    void poll(controller.signal);
    const timer = window.setInterval(() => void poll(controller.signal), 1500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [poll, reload]);

  // POM's loader says what the editor is doing; the frame's load opens the screen.
  // `t` is a new function on every render; the loader follows state changes, not renders.
  const say = useRef(t);
  say.current = t;
  useEffect(() => {
    if (!covered) return;
    const t = say.current;
    if (state === "error") {
      void loader.error({ title: t("failed"), message, retry: canRestart });
    } else if (state === "starting" && install) {
      installed.current = true;
      const share = install.total ? install.downloaded / install.total : 0;
      void loader.progress({
        title: t("loader.installing"),
        progress: Math.floor(share * 95),
        message: install.total
          ? t("installingProgress", { done: megabytes(install.downloaded), total: megabytes(install.total), percent: Math.floor(share * 100) })
          : t("installingBytes", { done: megabytes(install.downloaded) }),
      });
    } else if (state === "starting") {
      void (installed.current
        ? loader.progress({ title: t("loader.installing"), progress: 100, message: t("starting") })
        : loader.show({ message: t("starting") }));
    }
  }, [covered, state, install, message, canRestart]);

  const frameLoaded = () => {
    if (!covered) return;
    void (installed.current ? loader.success() : loader.hide());
    installed.current = false;
  };

  // The editor frame is the content of this screen: the host opens it when
  // there is an editor to show (or a failure to explain), not over the
  // starting spinner.
  useScreenReady(state === "ready" || state === "error");

  const restart = async () => {
    setState("starting");
    setCanRestart(false);
    setMessage("");
    startedAt.current = Date.now();
    try {
      const response = await fetch(`${PROXY}/_pom/restart`, { method: "POST", cache: "no-store" });
      if (!response.ok) {
        // No editor process (e.g. the download failed): restart the plugin side.
        const rpc = pluginRpc();
        if (!rpc) throw new Error("restart unavailable");
        await rpc("runtime.retry");
      }
      setReload((value) => value + 1);
    } catch {
      setState("error");
      setCanRestart(false);
      setMessage(t("unavailableDetail"));
    }
  };

  // "Try again" on the loader's error restarts the editor.
  const restartRef = useRef(restart);
  restartRef.current = restart;
  useEffect(() => onLoaderRetry(() => void restartRef.current()), []);

  return (
    <main className="cs-page">
      {state === "ready" ? (
        <iframe
          key={reload}
          className="cs-frame"
          src={`${PROXY}/`}
          title={t("frameTitle")}
          allow="clipboard-read; clipboard-write"
          onLoad={frameLoaded}
        />
      ) : covered ? null : (
        <section className="cs-status" role="status" aria-live="polite">
          {state === "starting" && <span className="cs-spinner" aria-hidden="true" />}
          <h1 className="cs-title">{state === "error" ? t("failed") : install ? t("installing") : t("starting")}</h1>
          <p className="cs-detail">{state === "error" ? message : install ? t("installingDetail", { version: install.version }) : t("startingDetail")}</p>
          {state === "starting" && install && (
            <div className="cs-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={install.total ? Math.round((install.downloaded / install.total) * 100) : undefined}>
              <div className="cs-progress-bar" style={{ width: install.total ? `${(install.downloaded / install.total) * 100}%` : "30%" }} />
              <span className="cs-progress-label">
                {install.total
                  ? t("installingProgress", { done: megabytes(install.downloaded), total: megabytes(install.total), percent: Math.floor((install.downloaded / install.total) * 100) })
                  : t("installingBytes", { done: megabytes(install.downloaded) })}
              </span>
            </div>
          )}
          {state === "error" && canRestart && (
            <button className="cs-button" type="button" onClick={() => void restart()}>
              {t("retry")}
            </button>
          )}
        </section>
      )}
      {state === "ready" && message && <span className="cs-version">{message}</span>}
    </main>
  );
}

type I18nHook = () => { t: (key: string, values?: Record<string, unknown>) => string; locale: string };
type Host = { hooks?: { useI18n?: I18nHook } };

declare const __POM_PLUGIN_CODE__: string;

export function usePluginI18n(): ReturnType<I18nHook> {
  const host = (globalThis as typeof globalThis & { __POM_HOST__?: Host }).__POM_HOST__;
  if (!host?.hooks?.useI18n) throw new Error("POM host i18n is unavailable");
  const { t, locale } = host.hooks.useI18n();
  return { t: (key, values) => t(`${__POM_PLUGIN_CODE__}.${key}`, values), locale };
}

type Rpc = <T>(op: string, params?: unknown) => Promise<T>;

/** The plugin's own API through the POM (host version 4), when available. */
export function pluginRpc(): Rpc | null {
  const host = (globalThis as typeof globalThis & { __POM_HOST__?: { plugin?: (code: string) => { rpc?: Rpc } } }).__POM_HOST__;
  const scoped = typeof host?.plugin === "function" ? host.plugin(__POM_PLUGIN_CODE__) : null;
  return typeof scoped?.rpc === "function" ? scoped.rpc : null;
}

type LoaderReply = { action: "delivered" | "failed"; error?: string };
type LoaderText = { title?: string; message?: string };

/** POM's loader and installer over this plugin's screen (host version 7). */
type HostLoader = {
  show: (request?: LoaderText) => Promise<LoaderReply>;
  progress: (request: LoaderText & { progress: number }) => Promise<LoaderReply>;
  error: (request: LoaderText & { message: string; retry?: boolean }) => Promise<LoaderReply>;
  success: (request?: LoaderText) => Promise<LoaderReply>;
  hide: () => Promise<LoaderReply>;
};

type ScopedApi = {
  rpc?: Rpc;
  loader?: HostLoader;
  events?: { subscribe: (type: string, handler: () => void) => () => void };
};

function scoped(): ScopedApi | null {
  const current = (globalThis as typeof globalThis & {
    __POM_HOST__?: { plugin?: (code: string) => ScopedApi };
  }).__POM_HOST__;
  return typeof current?.plugin === "function" ? current.plugin(__POM_PLUGIN_CODE__) : null;
}

/** The host SDK version: 4 RPC, 6 `ready()`, 7 the loader. */
export function hostVersion(): number {
  return (globalThis as typeof globalThis & { __POM_HOST__?: { version?: number } }).__POM_HOST__?.version ?? 1;
}

const noLoader = (): Promise<LoaderReply> => Promise.resolve({ action: "failed", error: "host_unavailable" });

/**
 * POM draws the loader and the installer; the plugin only says what is going
 * on. While the plugin holds one of these states its screen stays covered;
 * `hide()` or the end of `success()` opens it.
 */
export const loader: HostLoader = {
  show: (request = {}) => scoped()?.loader?.show(request) ?? noLoader(),
  progress: (request) => scoped()?.loader?.progress(request) ?? noLoader(),
  error: (request) => scoped()?.loader?.error(request) ?? noLoader(),
  success: (request = {}) => scoped()?.loader?.success(request) ?? noLoader(),
  hide: () => scoped()?.loader?.hide() ?? noLoader(),
};

/** "Try again" on the loader's error (`loader.retry`). Returns the unsubscribe function. */
export function onLoaderRetry(handler: () => void): () => void {
  const api = scoped();
  if (api?.events) return api.events.subscribe("loader.retry", handler);
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ protocol?: string; type?: string; target?: string }>).detail;
    if (detail?.protocol !== "pom-plugin-events/v1" || detail.type !== "loader.retry") return;
    if (detail.target === "*" || detail.target === __POM_PLUGIN_CODE__) handler();
  };
  window.addEventListener("pom:plugin-event", listener);
  return () => window.removeEventListener("pom:plugin-event", listener);
}

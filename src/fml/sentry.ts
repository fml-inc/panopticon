declare const __SENTRY_DSN__: string;

let initialized = false;
let sentry: typeof import("@sentry/core") | null = null;

async function loadSentry(): Promise<typeof import("@sentry/core") | null> {
  if (sentry) return sentry;
  try {
    sentry = await import("@sentry/core");
    return sentry;
  } catch {
    return null;
  }
}

export async function initSentry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const mod = await loadSentry();
  if (!mod) return;

  const client = new mod.ServerRuntimeClient({
    dsn: __SENTRY_DSN__,
    tracesSampleRate: 0,
    integrations: [],
    stackParser: mod.createStackParser(mod.nodeStackLineParser()),
    transport: (options) =>
      mod.createTransport(options, async (request) => {
        const res = await fetch(options.url, {
          method: "POST",
          headers: { "Content-Type": "application/x-sentry-envelope" },
          body: request.body as BodyInit,
        });
        return { statusCode: res.status };
      }),
  });

  mod.setCurrentClient(client);
  client.init();
}

export const Sentry = {
  captureException: (err: unknown) => sentry?.captureException(err),
  captureMessage: (msg: string) => sentry?.captureMessage(msg),
} as const;

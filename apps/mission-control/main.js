// Panopticon Mission Control — Electron main process.
//
// A thin native shell over the server-rendered dashboard. It discovers the
// running Panopticon server (port from env or the uid-offset default), opens a
// window on http://127.0.0.1:<port>/ui (which self-injects the auth token), adds
// a menu-bar tray, and turns frenemy-challenge events forwarded from the
// renderer into native OS notifications. All data flows through the server's
// SSE + /api contract — this process holds no DB handle and forks no data path.

const http = require("node:http");
const path = require("node:path");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  nativeImage,
  shell,
} = require("electron");

const DEFAULT_PORT_BASE = 4318;

/** Mirror src/config.ts defaultPort(): base + (uid % 100), overridable by env. */
function resolvePort() {
  const fromEnv =
    process.env.PANOPTICON_PORT ?? process.env.PANOPTICON_OTLP_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const uidOffset = (process.getuid?.() ?? 0) % 100;
  return DEFAULT_PORT_BASE + uidOffset;
}

const PORT = resolvePort();
const HOST = process.env.PANOPTICON_HOST ?? "127.0.0.1";
const UI_URL = `http://${HOST}:${PORT}/ui`;

let mainWindow = null;
let tray = null;

/** Poll /health until the server answers (or give up after ~timeout). */
function waitForServer(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(
        { host: HOST, port: PORT, path: "/health", timeout: 1500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(attempt, 400);
    };
    attempt();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0b0e14",
    title: "Mission Control",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(UI_URL);

  // Open external links in the system browser, not inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  // Avoid shipping a binary asset: start from an empty image and rely on a
  // text title in the macOS menu bar. On other platforms the menu still works
  // via right-click even if the icon is blank.
  try {
    tray = new Tray(nativeImage.createEmpty());
    if (process.platform === "darwin") tray.setTitle(" ◎");
    tray.setToolTip("Panopticon Mission Control");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open Mission Control", click: showWindow },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
      ]),
    );
    tray.on("click", showWindow);
  } catch {
    // Tray is a nice-to-have; the window is the primary surface.
  }
}

app.whenReady().then(async () => {
  createTray();
  const up = await waitForServer();
  if (!up) {
    // Still open the window — it will show the browser's connection error and
    // the SSE client will reconnect once the server comes up.
    console.warn(`Panopticon server not reachable at ${UI_URL} yet.`);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Native notification on a frenemy challenge forwarded from the renderer.
const { ipcMain } = require("electron");
ipcMain.on("panopticon:challenge", (_event, msg) => {
  if (!Notification.isSupported()) return;
  const body = typeof msg?.body === "string" ? msg.body : "A challenge arrived";
  const n = new Notification({
    title: "🔴 Frenemy challenge",
    body: msg?.ref_path ? `${body}\n${msg.ref_path}` : body,
    silent: false,
  });
  n.on("click", showWindow);
  n.show();
});

// Keep the app alive in the tray on macOS; quit elsewhere when windows close.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Single instance: focus the existing window instead of launching a second.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
}

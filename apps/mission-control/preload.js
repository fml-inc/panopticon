// Preload bridge for the Mission Control desktop shell.
//
// The renderer loads the same web page the server serves at /ui. That page
// calls `window.__PANOPTICON_HOST__.onChallenge(msg)` whenever a frenemy
// challenge arrives over the SSE stream; here we forward it to the main process
// so it can raise a native OS notification. In a plain browser this global is
// simply absent and the page no-ops — same code, two hosts.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__PANOPTICON_HOST__", {
  onChallenge: (msg) => ipcRenderer.send("panopticon:challenge", msg),
});

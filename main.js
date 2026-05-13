const fs = require("node:fs");
const path = require("node:path");

const { app, BrowserWindow, ipcMain, Menu, session, webContents } = require("electron");

const DEFAULT_URL = "http://127.0.0.1:80";

let mainWindow = null;
let initialUrl = DEFAULT_URL;
let shellStatePath = "";
let latestShellState = null;
let isClosingMainWindow = false;
let isFinalShellStateSaveInProgress = false;

function normalizeUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed).toString();
  } catch (error) {
    console.warn(`[aivuda-electron-shell] ignoring invalid URL "${trimmed}": ${error.message}`);
    return null;
  }
}

function getUrlFromArgs(argv) {
  const passthroughIndex = argv.indexOf("--");
  const candidates = passthroughIndex >= 0 ? argv.slice(passthroughIndex + 1) : argv.slice(2);

  for (const candidate of candidates) {
    if (candidate.startsWith("-")) {
      continue;
    }

    const normalized = normalizeUrl(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function resolveInitialUrl() {
  return getUrlFromArgs(process.argv) || normalizeUrl(process.env.AIVUDA_SHELL_URL) || DEFAULT_URL;
}

function shouldBypassCertificateValidation(rawUrl) {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch (_error) {
    return false;
  }
}

function getShellStatePath() {
  return path.join(app.getPath("userData"), "shell-state.json");
}

function readShellState() {
  if (!shellStatePath) {
    shellStatePath = getShellStatePath();
  }

  try {
    const raw = fs.readFileSync(shellStatePath, "utf8");
    const parsed = JSON.parse(raw);
    latestShellState = parsed && typeof parsed === "object" ? parsed : null;
    console.log("[aivuda-electron-shell] loaded shell state from", shellStatePath);
    return latestShellState;
  } catch (_error) {
    return null;
  }
}

function writeShellState(state) {
  if (!shellStatePath) {
    shellStatePath = getShellStatePath();
  }

  latestShellState = state;

  const parentDir = path.dirname(shellStatePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(shellStatePath, JSON.stringify(latestShellState, null, 2), "utf8");
}

function persistLatestShellState() {
  if (!latestShellState) {
    return;
  }

  const parentDir = path.dirname(shellStatePath || getShellStatePath());
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(shellStatePath || getShellStatePath(), JSON.stringify(latestShellState, null, 2), "utf8");
}

async function saveFinalShellStateBeforeClose(windowToClose) {
  if (!windowToClose || windowToClose.isDestroyed()) {
    return;
  }

  try {
    const state = await windowToClose.webContents.executeJavaScript(
      "typeof window.__aivudaBuildShellState === 'function' ? window.__aivudaBuildShellState() : null",
      true,
    );

    if (state) {
      writeShellState(state);
      return;
    }
  } catch (error) {
    console.error("[aivuda-electron-shell] failed to read final shell state from renderer", error);
  }

  persistLatestShellState();
}

function clearShellState() {
  if (!shellStatePath) {
    shellStatePath = getShellStatePath();
  }

  latestShellState = null;
  try {
    fs.rmSync(shellStatePath, { force: true });
  } catch (_error) {}
}

function sendToShell(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(channel, payload);
}

function createMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "New Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => sendToShell("aivuda-shell:new-tab", { url: DEFAULT_URL }),
        },
        {
          label: "Close Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendToShell("aivuda-shell:close-current-tab"),
        },
        { type: "separator" },
        {
          label: "Quit",
          accelerator: process.platform === "darwin" ? "Cmd+Q" : "Ctrl+Q",
          click: () => app.quit(),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload Tab",
          accelerator: "CmdOrCtrl+R",
          click: () => sendToShell("aivuda-shell:reload-current-tab"),
        },
        {
          label: "Show Tabs and Address Bar",
          accelerator: "CmdOrCtrl+L",
          click: () => sendToShell("aivuda-shell:show-browser-chrome"),
        },
        {
          label: "Hide Tabs and Address Bar",
          accelerator: "Escape",
          click: () => sendToShell("aivuda-shell:hide-browser-chrome"),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => sendToShell("aivuda-shell:toggle-devtools"),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          label: "Show FPS/GPU Overlay",
          accelerator: "CmdOrCtrl+Shift+P",
          click: () => sendToShell("aivuda-shell:show-performance-overlay"),
        },
        {
          label: "Hide FPS/GPU Overlay",
          click: () => sendToShell("aivuda-shell:hide-performance-overlay"),
        },
        {
          label: "Toggle FPS/GPU Overlay",
          click: () => sendToShell("aivuda-shell:toggle-performance-overlay"),
        },
        { type: "separator" },
        {
          label: "Clear Browser Data",
          accelerator: "CmdOrCtrl+Shift+Backspace",
          click: () => sendToShell("aivuda-shell:clear-browser-data"),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  initialUrl = resolveInitialUrl();
  isClosingMainWindow = false;

  mainWindow = new BrowserWindow({
    title: "AivudaOS",
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.on("close", async (event) => {
    if (isClosingMainWindow) {
      return;
    }

    event.preventDefault();

    if (isFinalShellStateSaveInProgress) {
      return;
    }

    isFinalShellStateSaveInProgress = true;
    const windowToClose = mainWindow;
    await saveFinalShellStateBeforeClose(windowToClose);
    isClosingMainWindow = true;
    isFinalShellStateSaveInProgress = false;

    if (windowToClose && !windowToClose.isDestroyed()) {
      windowToClose.close();
    }
  });

  mainWindow.on("closed", () => {
    isClosingMainWindow = false;
    isFinalShellStateSaveInProgress = false;
    mainWindow = null;
  });

  mainWindow.webContents.on("did-attach-webview", (_event, webContentsView) => {
    webContentsView.setWindowOpenHandler(({ url }) => {
      sendToShell("aivuda-shell:open-url-in-new-tab", { url });
      return { action: "deny" };
    });
  });

  mainWindow.loadFile(path.join(__dirname, "shell.html"));
}

ipcMain.handle("aivuda-shell:get-startup", () => ({
  defaultUrl: DEFAULT_URL,
  initialUrl,
  savedState: readShellState(),
}));

ipcMain.handle("aivuda-shell:get-gpu-status", () => app.getGPUFeatureStatus());

ipcMain.handle("aivuda-shell:clear-browser-data", async () => {
  const partitionSession = session.fromPartition("persist:aivuda-shell");
  await partitionSession.clearStorageData();
  await partitionSession.clearCache();
  clearShellState();
  return { ok: true };
});
ipcMain.handle("aivuda-shell:save-shell-state", (_event, state) => {
  try {
    writeShellState(state);
    return { ok: true };
  } catch (error) {
    console.error("[aivuda-electron-shell] failed to save shell state", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.on("aivuda-shell:register-webview", (_event, guestInstanceId) => {
  const guest = webContents.fromId(Number(guestInstanceId));
  if (!guest) {
    return;
  }

  guest.setWindowOpenHandler(({ url }) => {
    sendToShell("aivuda-shell:open-url-in-new-tab", { url });
    return { action: "deny" };
  });
});

app.whenReady().then(() => {
  app.on("certificate-error", (event, _webContents, requestUrl, error, certificate, callback) => {
    if (!shouldBypassCertificateValidation(requestUrl)) {
      return;
    }

    event.preventDefault();
    console.warn(
      "[aivuda-electron-shell] bypassing certificate validation for",
      requestUrl,
      `error=${error}`,
      certificate?.issuerName ? `issuer=${certificate.issuerName}` : "",
    );
    callback(true);
  });

  createMenu();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  try {
    persistLatestShellState();
  } catch (error) {
    console.error("[aivuda-electron-shell] failed to persist latest shell state on quit", error);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

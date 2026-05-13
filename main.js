const path = require("node:path");

const { app, BrowserWindow, ipcMain, Menu, webContents } = require("electron");

const DEFAULT_URL = "http://127.0.0.1:80";

let mainWindow = null;
let initialUrl = DEFAULT_URL;

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
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  initialUrl = resolveInitialUrl();

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

  mainWindow.on("closed", () => {
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
}));

ipcMain.handle("aivuda-shell:get-gpu-status", () => app.getGPUFeatureStatus());

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
  createMenu();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell, webContents } = require("electron");

const DEFAULT_URL = "http://127.0.0.1:80";
const APP_ICON_PATH = path.join(__dirname, "assets", "aivuda_icon.png");
const DEFAULT_WINDOW_BOUNDS = {
  width: 1280,
  height: 800,
};
const MIN_WINDOW_BOUNDS = {
  width: 960,
  height: 640,
};

let mainWindow = null;
let initialUrl = DEFAULT_URL;
let shellStatePath = "";
let latestShellState = null;
let isClosingMainWindow = false;
let isFinalShellStateSaveInProgress = false;
let activeFfmpegRecording = null;
const certificateBypassConfiguredSessions = new WeakSet();

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
    console.warn(`[aivuda-shell] ignoring invalid URL "${trimmed}": ${error.message}`);
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
    const protocol = new URL(rawUrl).protocol;
    return protocol === "https:" || protocol === "wss:";
  } catch (_error) {
    return false;
  }
}

function installCertificateValidationBypass(targetSession, label = "session") {
  if (!targetSession || certificateBypassConfiguredSessions.has(targetSession)) {
    return;
  }

  targetSession.setCertificateVerifyProc((request, callback) => {
    console.warn(
      "[aivuda-shell] bypassing certificate verification for",
      `${label}:${request.hostname || "unknown-host"}`,
      `error=${request.errorCode}`,
      request.certificate?.issuerName ? `issuer=${request.certificate.issuerName}` : "",
    );
    callback(0);
  });
  certificateBypassConfiguredSessions.add(targetSession);
}

function getShellStatePath() {
  return path.join(app.getPath("userData"), "shell-state.json");
}

function getRecordingsDir() {
  try {
    const videosPath = app.getPath("videos");
    if (videosPath) {
      return path.join(videosPath, "Aivuda Shell");
    }
  } catch (_error) {}

  return path.join(app.getPath("userData"), "recordings");
}

function formatTimestampForFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + "-" + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("-");
}

function createRecordingOutputPath() {
  const recordingsDir = getRecordingsDir();
  fs.mkdirSync(recordingsDir, { recursive: true });
  return path.join(recordingsDir, `aivuda-shell-${formatTimestampForFilename()}.webm`);
}

function createFfmpegRecordingOutputPath() {
  const recordingsDir = getRecordingsDir();
  fs.mkdirSync(recordingsDir, { recursive: true });
  return path.join(recordingsDir, `aivuda-shell-${formatTimestampForFilename()}.mp4`);
}

function ensureFfmpegNotRunning() {
  if (activeFfmpegRecording?.process && activeFfmpegRecording.process.exitCode == null && !activeFfmpegRecording.stopping) {
    return false;
  }

  return true;
}

function checkFfmpegAvailable() {
  const result = spawnSync("ffmpeg", ["-version"], {
    stdio: "ignore",
  });

  if (result.error?.code === "ENOENT") {
    return false;
  }

  return !result.error;
}

async function showMissingFfmpegDialog() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  await dialog.showMessageBox(mainWindow, {
    type: "warning",
    buttons: ["OK"],
    defaultId: 0,
    message: "FFmpeg is not installed.",
    detail:
      'Run "sudo apt install ffmpeg -y" to install it. You can also switch the screen record bar mode to Native to avoid installing FFmpeg, but the recorded video file will usually be larger.',
  });
}

function normalizeFfmpegFrameSize(size) {
  return {
    width: Math.max(2, Math.floor(size.width / 2) * 2),
    height: Math.max(2, Math.floor(size.height / 2) * 2),
  };
}

function getWindowCaptureBounds(windowToRead = mainWindow) {
  if (!windowToRead || windowToRead.isDestroyed()) {
    return null;
  }

  const bounds = windowToRead.getBounds();
  const displayInfo = screen.getDisplayMatching(bounds);
  const scaleFactor = displayInfo?.scaleFactor || 1;

  return {
    width: Math.max(2, Math.round(bounds.width * scaleFactor)),
    height: Math.max(2, Math.round(bounds.height * scaleFactor)),
    offsetX: Math.round(bounds.x * scaleFactor),
    offsetY: Math.round(bounds.y * scaleFactor),
    display: process.env.DISPLAY || ":0.0",
  };
}

function createFfmpegFrameBuffer(image, frameSize) {
  let frameImage = image;
  const imageSize = frameImage.getSize();
  if (imageSize.width !== frameSize.width || imageSize.height !== frameSize.height) {
    frameImage = frameImage.resize({
      width: frameSize.width,
      height: frameSize.height,
    });
  }

  const frameBuffer = frameImage.toBitmap();
  const expectedFrameSize = frameSize.width * frameSize.height * 4;
  if (frameBuffer.length !== expectedFrameSize) {
    throw new Error(`Captured frame has ${frameBuffer.length} bytes, expected ${expectedFrameSize}.`);
  }

  return frameBuffer;
}

function scheduleNextFfmpegFrame(recording) {
  if (!recording || recording.stopping) {
    return;
  }

  const frameIntervalMs = Math.max(1, Math.round(1000 / recording.frameRate));
  recording.captureTimer = setTimeout(async () => {
    if (!activeFfmpegRecording || activeFfmpegRecording !== recording || recording.stopping) {
      return;
    }

    if (recording.paused || recording.captureInFlight) {
      scheduleNextFfmpegFrame(recording);
      return;
    }

    recording.captureInFlight = true;
    try {
      const image = await mainWindow.webContents.capturePage();
      const frameBuffer = createFfmpegFrameBuffer(image, recording);
      if (recording.process.stdin && !recording.process.stdin.destroyed) {
        const canWrite = recording.process.stdin.write(frameBuffer);
        if (!canWrite) {
          await new Promise((resolve, reject) => {
            recording.process.stdin.once("drain", resolve);
            recording.process.stdin.once("error", reject);
          });
        }
      }
    } catch (error) {
      recording.stderr = `${recording.stderr || ""}\nframe-capture-error: ${error.message}`.trim();
      recording.stopping = true;
      if (recording.process.stdin && !recording.process.stdin.destroyed) {
        recording.process.stdin.end();
      }
    } finally {
      recording.captureInFlight = false;
      if (recording.stopping) {
        if (recording.process.stdin && !recording.process.stdin.destroyed) {
          recording.process.stdin.end();
        }
        return;
      }
      scheduleNextFfmpegFrame(recording);
    }
  }, frameIntervalMs);
}

function buildFfmpegStopResult(recording, code, signal) {
  const stderr = (recording.stderr || "").trim();
  const outputExists =
    typeof recording.outputPath === "string" &&
    recording.outputPath &&
    fs.existsSync(recording.outputPath) &&
    fs.statSync(recording.outputPath).size > 0;

  if (code === 0 || signal === "SIGINT" || signal === "SIGKILL" || outputExists) {
    return {
      ok: true,
      outputPath: recording.outputPath,
      stderr,
    };
  }

  return {
    ok: false,
    error: stderr || `ffmpeg exited with code ${code == null ? "unknown" : code}`,
  };
}

function stopActiveFfmpegRecording() {
  if (!activeFfmpegRecording) {
    return Promise.resolve({ ok: true });
  }

  if (activeFfmpegRecording.stopPromise) {
    return activeFfmpegRecording.stopPromise;
  }

  activeFfmpegRecording.stopping = true;
  if (activeFfmpegRecording.captureTimer) {
    clearTimeout(activeFfmpegRecording.captureTimer);
    activeFfmpegRecording.captureTimer = null;
  }
  activeFfmpegRecording.stopPromise = new Promise((resolve) => {
    const recording = activeFfmpegRecording;
    let forcedKillTimer = null;
    let failSafeTimer = null;
    let didFinalize = false;
    const finalize = (result) => {
      if (didFinalize) {
        return;
      }
      didFinalize = true;
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
      }
      if (failSafeTimer) {
        clearTimeout(failSafeTimer);
      }
      if (activeFfmpegRecording === recording) {
        activeFfmpegRecording = null;
      }
      resolve(result);
    };

    const finalizeFromProcessState = () => {
      finalize(buildFfmpegStopResult(recording, recording.process.exitCode, recording.process.signalCode));
    };

    recording.process.once("exit", (code, signal) => {
      finalize(buildFfmpegStopResult(recording, code, signal));
    });

    if (recording.process.exitCode != null || recording.process.signalCode != null) {
      process.nextTick(finalizeFromProcessState);
      return;
    }

    try {
      failSafeTimer = setTimeout(finalizeFromProcessState, 9000);
      forcedKillTimer = setTimeout(() => {
        try {
          if (recording.process.exitCode == null) {
            recording.process.kill("SIGINT");
          }
        } catch (_error) {}

        setTimeout(() => {
          try {
            if (recording.process.exitCode == null) {
              recording.process.kill("SIGKILL");
            }
          } catch (_error) {}
        }, 1500);
      }, 4000);

      if (recording.captureInFlight) {
        return;
      }

      if (recording.process.stdin && !recording.process.stdin.destroyed) {
        recording.process.stdin.end();
      } else {
        recording.process.kill("SIGINT");
      }
    } catch (error) {
      finalize({ ok: false, error: error.message });
    }
  });

  return activeFfmpegRecording.stopPromise;
}

function readShellState() {
  if (!shellStatePath) {
    shellStatePath = getShellStatePath();
  }

  try {
    const raw = fs.readFileSync(shellStatePath, "utf8");
    const parsed = JSON.parse(raw);
    latestShellState = parsed && typeof parsed === "object" ? parsed : null;
    console.log("[aivuda-shell] loaded shell state from", shellStatePath);
    return latestShellState;
  } catch (_error) {
    return null;
  }
}

function normalizeWindowState(rawState) {
  const rawBounds = rawState && typeof rawState === "object" ? rawState.windowBounds : null;
  if (!rawBounds || typeof rawBounds !== "object") {
    return null;
  }

  const width = Math.max(MIN_WINDOW_BOUNDS.width, Math.floor(Number(rawBounds.width)));
  const height = Math.max(MIN_WINDOW_BOUNDS.height, Math.floor(Number(rawBounds.height)));
  const x = Math.floor(Number(rawBounds.x));
  const y = Math.floor(Number(rawBounds.y));

  if (![x, y, width, height].every(Number.isFinite)) {
    return null;
  }

  const display = screen.getDisplayMatching({ x, y, width, height });
  const workArea = display.workArea;
  const safeWidth = Math.min(width, workArea.width);
  const safeHeight = Math.min(height, workArea.height);

  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - safeWidth),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - safeHeight),
    width: safeWidth,
    height: safeHeight,
    isMaximized: rawState.isMaximized === true,
  };
}

function getWindowState(windowToRead = mainWindow) {
  if (!windowToRead || windowToRead.isDestroyed()) {
    return {};
  }

  return {
    windowBounds: windowToRead.getNormalBounds(),
    isMaximized: windowToRead.isMaximized(),
  };
}

function mergeShellStateWithWindowState(state) {
  return {
    ...(state && typeof state === "object" ? state : {}),
    ...getWindowState(),
  };
}

function writeShellState(state) {
  if (!shellStatePath) {
    shellStatePath = getShellStatePath();
  }

  latestShellState = mergeShellStateWithWindowState(state);

  const parentDir = path.dirname(shellStatePath);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(shellStatePath, JSON.stringify(latestShellState, null, 2), "utf8");
}

function persistLatestShellState() {
  latestShellState = mergeShellStateWithWindowState(latestShellState);

  if (!latestShellState || Object.keys(latestShellState).length === 0) {
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
    console.error("[aivuda-shell] failed to read final shell state from renderer", error);
  }

  persistLatestShellState();
}

async function finalizeActiveRecordingBeforeClose(windowToClose) {
  const ffmpegResult = await stopActiveFfmpegRecording();
  if (!ffmpegResult?.ok) {
    return ffmpegResult;
  }

  if (!windowToClose || windowToClose.isDestroyed()) {
    return { ok: true };
  }

  try {
    const result = await windowToClose.webContents.executeJavaScript(
      "typeof window.__aivudaFinalizeActiveRecordingBeforeClose === 'function' ? window.__aivudaFinalizeActiveRecordingBeforeClose() : { ok: true }",
      true,
    );
    return result && typeof result === "object" ? result : { ok: true };
  } catch (error) {
    console.error("[aivuda-shell] failed to finalize active recording before close", error);
    return { ok: false, error: error.message };
  }
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

function zoomMenuAction(channel) {
  return () => sendToShell(channel);
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
          label: "Toggle Tab Bar",
          accelerator: "CmdOrCtrl+L",
          click: () => sendToShell("aivuda-shell:toggle-browser-chrome"),
        },
        {
          label: "Hide Tab Bar",
          accelerator: "Escape",
          click: () => sendToShell("aivuda-shell:hide-browser-chrome"),
        },
        {
          label: "Toggle Developer Tools",
          accelerator: process.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
          click: () => sendToShell("aivuda-shell:toggle-devtools"),
        },
        { type: "separator" },
        {
          label: "Actual Size",
          accelerator: "CmdOrCtrl+0",
          click: zoomMenuAction("aivuda-shell:reset-zoom"),
        },
        {
          label: "Zoom In",
          accelerator: "CmdOrCtrl+Plus",
          click: zoomMenuAction("aivuda-shell:zoom-in"),
        },
        {
          label: "Zoom Out",
          accelerator: "CmdOrCtrl+-",
          click: zoomMenuAction("aivuda-shell:zoom-out"),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Tab Bar",
      click: () => sendToShell("aivuda-shell:toggle-browser-chrome"),
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
          label: "Screen Record",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => sendToShell("aivuda-shell:toggle-screen-record-bar"),
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
  const savedState = readShellState();
  const savedWindowState = normalizeWindowState(savedState);
  const persistedShellSession = session.fromPartition("persist:aivuda-shell");
  installCertificateValidationBypass(session.defaultSession, "default-session");
  installCertificateValidationBypass(persistedShellSession, "persist:aivuda-shell");

  mainWindow = new BrowserWindow({
    title: "AivudaOS",
    width: savedWindowState?.width || DEFAULT_WINDOW_BOUNDS.width,
    height: savedWindowState?.height || DEFAULT_WINDOW_BOUNDS.height,
    x: savedWindowState?.x,
    y: savedWindowState?.y,
    minWidth: MIN_WINDOW_BOUNDS.width,
    minHeight: MIN_WINDOW_BOUNDS.height,
    backgroundColor: "#f4f6f8",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  });

  if (savedWindowState?.isMaximized) {
    mainWindow.maximize();
  }

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
    const recordingFinalizeResult = await finalizeActiveRecordingBeforeClose(windowToClose);
    if (!recordingFinalizeResult?.ok) {
      isFinalShellStateSaveInProgress = false;
      return;
    }

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
  recordingsDir: getRecordingsDir(),
  savedState: readShellState(),
}));

ipcMain.handle("aivuda-shell:get-gpu-status", () => app.getGPUFeatureStatus());

ipcMain.handle("aivuda-shell:clear-browser-data", async () => {
  const persistedShellSession = session.fromPartition("persist:aivuda-shell");
  await persistedShellSession.clearStorageData();
  await persistedShellSession.clearCache();
  clearShellState();
  return { ok: true };
});
ipcMain.handle("aivuda-shell:save-shell-state", (_event, state) => {
  try {
    writeShellState(state);
    return { ok: true };
  } catch (error) {
    console.error("[aivuda-shell] failed to save shell state", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:open-path", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, error: "Missing path to open." };
  }

  try {
    const result = await shell.openPath(targetPath);
    if (result) {
      return { ok: false, error: result };
    }
    return { ok: true };
  } catch (error) {
    console.error("[aivuda-shell] failed to open path", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:show-item-in-folder", async (_event, targetPath) => {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    return { ok: false, error: "Missing path to reveal." };
  }

  try {
    shell.showItemInFolder(targetPath);
    return { ok: true };
  } catch (error) {
    console.error("[aivuda-shell] failed to show item in folder", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:prepare-window-recording", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "Main window is not available." };
  }

  try {
    const outputPath = createRecordingOutputPath();
    const preferredSourceId = typeof mainWindow.getMediaSourceId === "function" ? mainWindow.getMediaSourceId() : "";
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });

    const source =
      sources.find((entry) => preferredSourceId && entry.id === preferredSourceId) ||
      sources.find((entry) => entry.name === mainWindow.getTitle()) ||
      sources[0];

    if (!source) {
      return { ok: false, error: "No capturable window source was found." };
    }

    return {
      ok: true,
      sourceId: source.id,
      outputPath,
      recordingsDir: path.dirname(outputPath),
    };
  } catch (error) {
    console.error("[aivuda-shell] failed to prepare window recording", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:save-recording-file", async (_event, payload) => {
  const outputPath = payload?.outputPath;
  const buffer = payload?.buffer;
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return { ok: false, error: "Missing recording output path." };
  }

  if (!buffer) {
    return { ok: false, error: "Missing recording buffer." };
  }

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, Buffer.from(buffer));
    return { ok: true, outputPath };
  } catch (error) {
    console.error("[aivuda-shell] failed to save recording file", error);
    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:start-ffmpeg-window-recording", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "Main window is not available." };
  }

  if (!ensureFfmpegNotRunning()) {
    return { ok: false, error: "FFmpeg recording is already running." };
  }

  if (!checkFfmpegAvailable()) {
    await showMissingFfmpegDialog();
    return {
      ok: false,
      error:
        'FFmpeg is not installed. Run "sudo apt install ffmpeg -y" to install it, or switch the screen record bar mode to Native if you want to avoid installing FFmpeg at the cost of larger video files.',
    };
  }

  const outputPath = createFfmpegRecordingOutputPath();
  const firstImage = await mainWindow.webContents.capturePage().catch((error) => {
    throw error;
  });
  const firstSize = normalizeFfmpegFrameSize(firstImage.getSize());
  const frameRate = 25;
  const args = [
    "-y",
    "-hide_banner",
    "-f",
    "rawvideo",
    "-r",
    String(frameRate),
    "-pix_fmt",
    "bgra",
    "-s",
    `${firstSize.width}x${firstSize.height}`,
    "-i",
    "-",
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];

  try {
    const child = spawn("ffmpeg", args, {
      stdio: ["pipe", "ignore", "pipe"],
    });

    activeFfmpegRecording = {
      process: child,
      outputPath,
      stderr: "",
      paused: false,
      stopping: false,
      stopPromise: null,
      width: firstSize.width,
      height: firstSize.height,
      frameRate,
      captureTimer: null,
      captureInFlight: false,
    };

    child.stderr.on("data", (chunk) => {
      if (activeFfmpegRecording?.process === child) {
        activeFfmpegRecording.stderr = (activeFfmpegRecording.stderr || "") + chunk.toString();
      }
    });

    child.once("error", (error) => {
      activeFfmpegRecording = null;
      if (error.code === "ENOENT") {
        return;
      }
    });

    if (child.pid == null) {
      throw new Error("FFmpeg did not start correctly.");
    }

    const firstFrameBuffer = createFfmpegFrameBuffer(firstImage, firstSize);
    const canWrite = child.stdin.write(firstFrameBuffer);
    if (!canWrite) {
      await new Promise((resolve, reject) => {
        child.stdin.once("drain", resolve);
        child.stdin.once("error", reject);
      });
    }

    scheduleNextFfmpegFrame(activeFfmpegRecording);

    return {
      ok: true,
      outputPath,
      recordingsDir: path.dirname(outputPath),
      width: firstSize.width,
      height: firstSize.height,
      frameRate,
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        error:
          'FFmpeg is not installed. Run "sudo apt install ffmpeg -y" to install it, or switch the screen record bar mode to Native if you want to avoid installing FFmpeg at the cost of larger video files.',
      };
    }

    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:start-ffmpeg-x11-recording", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false, error: "Main window is not available." };
  }

  if (!ensureFfmpegNotRunning()) {
    return { ok: false, error: "FFmpeg recording is already running." };
  }

  if (!checkFfmpegAvailable()) {
    await showMissingFfmpegDialog();
    return {
      ok: false,
      error:
        'FFmpeg is not installed. Run "sudo apt install ffmpeg -y" to install it, or switch the screen record bar mode to Native if you want to avoid installing FFmpeg at the cost of larger video files.',
    };
  }

  const captureBounds = getWindowCaptureBounds(mainWindow);
  if (!captureBounds) {
    return { ok: false, error: "Could not resolve current window bounds for FFmpeg X11 capture." };
  }

  const outputPath = createFfmpegRecordingOutputPath();
  const args = [
    "-y",
    "-hide_banner",
    "-f",
    "x11grab",
    "-r",
    "25",
    "-s",
    `${captureBounds.width}x${captureBounds.height}`,
    "-i",
    `${captureBounds.display}+${captureBounds.offsetX},${captureBounds.offsetY}`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ];

  try {
    const child = spawn("ffmpeg", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    activeFfmpegRecording = {
      process: child,
      outputPath,
      stderr: "",
      paused: false,
      stopping: false,
      stopPromise: null,
      width: captureBounds.width,
      height: captureBounds.height,
      frameRate: 25,
      captureTimer: null,
      captureInFlight: false,
    };

    child.stderr.on("data", (chunk) => {
      if (activeFfmpegRecording?.process === child) {
        activeFfmpegRecording.stderr = (activeFfmpegRecording.stderr || "") + chunk.toString();
      }
    });

    child.once("error", (error) => {
      activeFfmpegRecording = null;
      if (error.code === "ENOENT") {
        return;
      }
    });

    if (child.pid == null) {
      throw new Error("FFmpeg X11 did not start correctly.");
    }

    return {
      ok: true,
      outputPath,
      recordingsDir: path.dirname(outputPath),
    };
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        error:
          'FFmpeg is not installed. Run "sudo apt install ffmpeg -y" to install it, or switch the screen record bar mode to Native if you want to avoid installing FFmpeg at the cost of larger video files.',
      };
    }

    return { ok: false, error: error.message };
  }
});

ipcMain.handle("aivuda-shell:pause-ffmpeg-window-recording", async () => {
  if (!activeFfmpegRecording?.process || activeFfmpegRecording.process.exitCode != null) {
    return { ok: false, error: "FFmpeg recording is not running." };
  }

  activeFfmpegRecording.paused = true;
  return { ok: true };
});

ipcMain.handle("aivuda-shell:resume-ffmpeg-window-recording", async () => {
  if (!activeFfmpegRecording?.process || activeFfmpegRecording.process.exitCode != null) {
    return { ok: false, error: "FFmpeg recording is not running." };
  }

  activeFfmpegRecording.paused = false;
  return { ok: true };
});

ipcMain.handle("aivuda-shell:stop-ffmpeg-window-recording", async () => {
  if (!activeFfmpegRecording) {
    return { ok: true };
  }

  return stopActiveFfmpegRecording();
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
      "[aivuda-shell] bypassing certificate validation for",
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
    console.error("[aivuda-shell] failed to persist latest shell state on quit", error);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

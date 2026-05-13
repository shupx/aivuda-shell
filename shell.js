const shellEl = document.getElementById("shell");
const tabsEl = document.getElementById("tabs");
const stackEl = document.getElementById("webview-stack");
const addressInput = document.getElementById("address-input");
const statusText = document.getElementById("status-text");
const collapseChromeButton = document.getElementById("collapse-chrome");
const newTabButton = document.getElementById("new-tab");
const backButton = document.getElementById("back-button");
const forwardButton = document.getElementById("forward-button");
const reloadButton = document.getElementById("reload-button");

let defaultUrl = "http://127.0.0.1:80";
let activeTabId = null;
let nextTabId = 1;
let performanceOverlayVisible = false;
let screenRecordBarVisible = false;
let screenRecordBarPosition = null;
let screenRecordBarEl = null;
let screenRecordDetailsExpanded = false;
let screenRecordMode = "native";
let screenRecordStatus = "idle";
let screenRecordStatusText = "Ready to record";
let screenRecordElapsedMs = 0;
let screenRecordStartedAt = 0;
let screenRecordAccumulatedMs = 0;
let screenRecordPausedAt = 0;
let screenRecordTimer = 0;
let screenRecorder = null;
let screenRecorderStream = null;
let screenRecorderChunks = [];
let screenRecorderOutputPath = "";
let screenRecorderOutputDir = "";
let screenRecorderLastSavedPath = "";
let isStoppingScreenRecorder = false;
let screenRecordFinalizePromise = null;
let screenRecordBackend = null;
const tabs = new Map();
const guestPreloadUrl = new URL("guest-preload.js", window.location.href).toString();
const offlineUrl = new URL("offline.html", window.location.href).toString();
let isRestoringShellState = true;
const shellStateAutosaveIntervalMs = 1500;

function normalizeSavedShellState(rawState) {
  if (!rawState || typeof rawState !== "object") {
    return null;
  }

  const tabs = Array.isArray(rawState.tabs)
    ? rawState.tabs.filter((tab) => tab && typeof tab.url === "string" && tab.url.trim())
    : [];
  const activeTabId = typeof rawState.activeTabId === "string" ? rawState.activeTabId : null;
  const chromeExpanded = rawState.chromeExpanded === true;
  const performanceOverlayVisible = rawState.performanceOverlayVisible === true;
  const screenRecordBarVisible = rawState.screenRecordBarVisible === true;
  const screenRecordMode = rawState.screenRecordMode === "ffmpeg" ? "ffmpeg" : "native";
  const screenRecordBarPosition =
    rawState.screenRecordBarPosition &&
    Number.isFinite(rawState.screenRecordBarPosition.left) &&
    Number.isFinite(rawState.screenRecordBarPosition.top)
      ? {
          left: rawState.screenRecordBarPosition.left,
          top: rawState.screenRecordBarPosition.top,
        }
      : null;

  return {
    tabs,
    activeTabId,
    chromeExpanded,
    performanceOverlayVisible,
    screenRecordBarVisible,
    screenRecordMode,
    screenRecordBarPosition,
  };
}

function buildShellStatePayload() {
  return {
    activeTabId,
    chromeExpanded: shellEl.classList.contains("expanded"),
    performanceOverlayVisible,
    screenRecordBarVisible,
    screenRecordMode,
    screenRecordBarPosition,
    tabs: Array.from(tabs.values()).map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: getTabUrl(tab),
    })),
  };
}

window.__aivudaBuildShellState = buildShellStatePayload;

function writeShellState() {
  if (isRestoringShellState) {
    return Promise.resolve();
  }

  return window.aivudaShell.saveShellState(buildShellStatePayload()).catch((error) => {
    console.warn("[aivuda-shell] failed to save shell state", error);
  });
}

function finishShellStateRestore() {
  isRestoringShellState = false;
  writeShellState();
}

function setChromeExpanded(isExpanded) {
  shellEl.classList.toggle("expanded", isExpanded);
  writeShellState();
}

function normalizeUrlInput(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return defaultUrl;
  }

  try {
    return new URL(trimmed).toString();
  } catch (_error) {
    try {
      return new URL(`http://${trimmed}`).toString();
    } catch (_fallbackError) {
      return defaultUrl;
    }
  }
}

function getActiveTab() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

function getTabUrl(tab) {
  if (!tab?.webview) {
    return tab?.url || defaultUrl;
  }

  try {
    return tab.webview.getURL() || tab.url;
  } catch (_error) {
    return tab.url;
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

function createTabButton(tab) {
  const button = document.createElement("button");
  button.className = "tab";
  button.type = "button";
  button.dataset.tabId = tab.id;
  button.setAttribute("role", "tab");

  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = tab.title;

  const close = document.createElement("span");
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "Close tab";

  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeTab(tab.id);
  });

  button.addEventListener("click", () => {
    activateTab(tab.id);
  });

  button.append(title, close);
  tabsEl.appendChild(button);
  return button;
}

function updateTabTitle(tab, title) {
  tab.title = title || "AivudaOS";
  tab.button.querySelector(".tab-title").textContent = tab.title;
  writeShellState();
}

function updateAddressFromActiveTab() {
  const tab = getActiveTab();
  addressInput.value = tab ? getTabUrl(tab) : "";
}

function updateNavigationState() {
  const tab = getActiveTab();
  try {
    backButton.disabled = !tab || !tab.webview.canGoBack();
    forwardButton.disabled = !tab || !tab.webview.canGoForward();
  } catch (_error) {
    backButton.disabled = true;
    forwardButton.disabled = true;
  }
}

function updateActiveClasses() {
  for (const tab of tabs.values()) {
    const isActive = tab.id === activeTabId;
    tab.button.classList.toggle("active", isActive);
    tab.button.setAttribute("aria-selected", String(isActive));
    tab.webview.classList.toggle("hidden", !isActive);
  }
}

function setPerformanceOverlayVisible(isVisible) {
  if (performanceOverlayVisible === isVisible) {
    return;
  }

  performanceOverlayVisible = isVisible;
  writeShellState();
}

function syncPerformanceOverlayForActiveTab() {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  injectPerformanceOverlay(tab, performanceOverlayVisible ? "show" : "hide");
}

async function injectPerformanceOverlay(tab, action) {
  if (!tab || !tab.webview || tab.webview.getURL().startsWith("file://")) {
    return;
  }

  const gpuStatus = await window.aivudaShell.getGpuStatus().catch(() => ({}));

  tab.webview.executeJavaScript(
    `
      (() => {
        const action = ${JSON.stringify(action)};
        const electronGpuStatus = ${JSON.stringify(gpuStatus)};
        const id = "aivuda-performance-overlay";
        const storageKey = "aivuda.performanceOverlay.position.v1";
        let overlay = document.getElementById(id);

        if (action === "hide") {
          if (overlay) overlay.remove();
          return;
        }

        if (action === "toggle" && overlay) {
          overlay.remove();
          return;
        }

        if (!overlay) {
          overlay = document.createElement("div");
          overlay.id = id;
          overlay.style.cssText = [
            "position:fixed",
            "right:16px",
            "top:16px",
            "z-index:2147483647",
            "min-width:fit-content",
            "max-width:240px",
            "padding:2px 3px 2px 4px",
            "border:1px solid rgba(148,163,184,0.22)",
            "border-radius:10px",
            "background:rgba(255,255,255,0.24)",
            "color:#102a43",
            "font:11px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "box-shadow:none",
            "backdrop-filter:blur(4px)",
            "cursor:move",
            "user-select:none"
          ].join(";");

          overlay.innerHTML = [
            '<div style="display:flex;align-items:center;gap:4px;">',
            '<span style="display:inline-block;width:7px;height:7px;border-radius:999px;background:#98a2b3;flex:0 0 auto;"></span>',
            '<span style="min-width:22px;font-weight:700;">FPS</span>',
            '<span data-fps style="min-width:20px;font-variant-numeric:tabular-nums;font-weight:700;">--</span>',
            '<button type="button" data-gpu-toggle title="GPU details" style="display:inline-grid;place-items:center;width:18px;height:18px;border:0;border-radius:999px;background:rgba(148,163,184,0.2);color:#334e68;font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0;">▾</button>',
            '<button type="button" data-close title="Hide" style="display:inline-grid;place-items:center;width:12px;height:12px;border:0;background:transparent;color:#52606d;font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0;">×</button>',
            '</div>',
            '<div data-gpu-row style="display:none;margin-top:2px;padding:4px 6px 2px;border-top:1px solid rgba(148,163,184,0.35);border-radius:8px;background:rgba(255,255,255,0.2);max-width:220px;overflow-wrap:anywhere;color:#334e68;">GPU: <span data-gpu>Checking...</span></div>'
          ].join("");

          document.documentElement.appendChild(overlay);

          try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
            if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
              overlay.style.left = saved.left + "px";
              overlay.style.top = saved.top + "px";
              overlay.style.right = "auto";
            }
          } catch (_error) {}

          const closeButton = overlay.querySelector("[data-close]");
          const gpuToggleButton = overlay.querySelector("[data-gpu-toggle]");
          const gpuRow = overlay.querySelector("[data-gpu-row]");
          closeButton.addEventListener("click", () => {
            overlay.remove();
            window.dispatchEvent(new CustomEvent("aivuda-shell:set-performance-overlay-visible", {
              detail: { visible: false }
            }));
          });
          gpuToggleButton.addEventListener("click", (event) => {
            event.stopPropagation();
            const isOpen = gpuRow.style.display !== "none";
            gpuRow.style.display = isOpen ? "none" : "block";
            gpuToggleButton.textContent = isOpen ? "▾" : "▴";
          });

          let drag = null;
          overlay.addEventListener("pointerdown", (event) => {
            if (event.target === closeButton || event.target === gpuToggleButton) return;
            const rect = overlay.getBoundingClientRect();
            drag = {
              offsetX: event.clientX - rect.left,
              offsetY: event.clientY - rect.top
            };
            overlay.setPointerCapture(event.pointerId);
          });

          overlay.addEventListener("pointermove", (event) => {
            if (!drag) return;
            const nextLeft = Math.max(0, Math.min(window.innerWidth - overlay.offsetWidth, event.clientX - drag.offsetX));
            const nextTop = Math.max(0, Math.min(window.innerHeight - overlay.offsetHeight, event.clientY - drag.offsetY));
            overlay.style.left = nextLeft + "px";
            overlay.style.top = nextTop + "px";
            overlay.style.right = "auto";
          });

          overlay.addEventListener("pointerup", () => {
            if (!drag) return;
            drag = null;
            const rect = overlay.getBoundingClientRect();
            localStorage.setItem(storageKey, JSON.stringify({ left: rect.left, top: rect.top }));
          });
        }

        const fpsEl = overlay.querySelector("[data-fps]");
        const gpuEl = overlay.querySelector("[data-gpu]");
        if (!overlay.__aivudaFpsLoop) {
          let frames = 0;
          let last = performance.now();
          const tick = (now) => {
            if (!document.getElementById(id)) return;
            frames += 1;
            const elapsed = now - last;
            if (elapsed >= 1000) {
              fpsEl.textContent = String(Math.round((frames * 1000) / elapsed));
              frames = 0;
              last = now;
            }
            requestAnimationFrame(tick);
          };
          overlay.__aivudaFpsLoop = true;
          requestAnimationFrame(tick);
        }

        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        const gpuSummary = [
          electronGpuStatus.gpu_compositing ? "compositing:" + electronGpuStatus.gpu_compositing : "",
          electronGpuStatus.webgl ? "webgl:" + electronGpuStatus.webgl : "",
          electronGpuStatus.webgl2 ? "webgl2:" + electronGpuStatus.webgl2 : ""
        ].filter(Boolean).join(", ");

        if (!gl) {
          gpuEl.textContent = gpuSummary ? gpuSummary + " / page WebGL unavailable" : "Unavailable";
          return;
        }

        const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
        if (debugInfo) {
          const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
          gpuEl.textContent = renderer
            ? (gpuSummary ? gpuSummary + " / " : "Enabled - ") + renderer
            : (gpuSummary || "Enabled");
        } else {
          gpuEl.textContent = gpuSummary || "Enabled";
        }
      })();
    `,
    true,
  ).catch((error) => {
    console.warn("[aivuda-shell] failed to inject performance overlay", error);
  });
}

function formatElapsedTime(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function setScreenRecordBarPosition(position) {
  if (
    position &&
    Number.isFinite(position.left) &&
    Number.isFinite(position.top) &&
    (!screenRecordBarPosition ||
      screenRecordBarPosition.left !== position.left ||
      screenRecordBarPosition.top !== position.top)
  ) {
    screenRecordBarPosition = {
      left: position.left,
      top: position.top,
    };
    writeShellState();
  }
}

function setScreenRecordBarVisible(isVisible) {
  if (screenRecordBarVisible === isVisible) {
    return;
  }

  screenRecordBarVisible = isVisible;
  writeShellState();
}

function setScreenRecordState(nextStatus, nextText) {
  screenRecordStatus = nextStatus;
  if (typeof nextText === "string") {
    screenRecordStatusText = nextText;
  }
  renderScreenRecordBar();
}

function stopScreenRecordTimer() {
  if (screenRecordTimer) {
    window.clearInterval(screenRecordTimer);
    screenRecordTimer = 0;
  }
}

function startScreenRecordTimer() {
  stopScreenRecordTimer();
  screenRecordTimer = window.setInterval(() => {
    if (screenRecordStatus !== "recording") {
      stopScreenRecordTimer();
      return;
    }
    screenRecordElapsedMs = screenRecordAccumulatedMs + (Date.now() - screenRecordStartedAt);
    renderScreenRecordBar();
  }, 250);
}

function cleanupScreenRecorderStream() {
  if (screenRecorderStream) {
    for (const track of screenRecorderStream.getTracks()) {
      track.stop();
    }
  }
  screenRecorderStream = null;
}

function canCloseScreenRecordBar() {
  return screenRecordStatus !== "recording" && screenRecordStatus !== "paused" && screenRecordStatus !== "stopping";
}

function updateScreenRecordBarLayout() {
  if (!screenRecordBarEl) {
    return;
  }

  if (screenRecordBarPosition) {
    screenRecordBarEl.style.left = `${screenRecordBarPosition.left}px`;
    screenRecordBarEl.style.top = `${screenRecordBarPosition.top}px`;
    screenRecordBarEl.style.right = "auto";
    screenRecordBarEl.style.bottom = "auto";
  }
}

function renderScreenRecordBar() {
  if (!screenRecordBarVisible) {
    if (screenRecordBarEl) {
      screenRecordBarEl.remove();
      screenRecordBarEl = null;
    }
    return;
  }

  if (!screenRecordBarEl) {
    const bar = document.createElement("div");
    bar.id = "aivuda-screen-record-bar";
    bar.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "min-width:fit-content",
      "max-width:320px",
      "padding:2px 3px 2px 4px",
      "border:1px solid rgba(148,163,184,0.22)",
      "border-radius:10px",
      "background:rgba(255,255,255,0.24)",
      "color:#102a43",
      "font:11px/1.2 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
      "box-shadow:none",
      "backdrop-filter:blur(4px)",
      "user-select:none"
    ].join(";");

    let drag = null;
    bar.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLButtonElement) {
        return;
      }

      const rect = bar.getBoundingClientRect();
      drag = {
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      bar.setPointerCapture(event.pointerId);
    });

    bar.addEventListener("pointermove", (event) => {
      if (!drag) {
        return;
      }

      const nextLeft = Math.max(0, Math.min(window.innerWidth - bar.offsetWidth, event.clientX - drag.offsetX));
      const nextTop = Math.max(0, Math.min(window.innerHeight - bar.offsetHeight, event.clientY - drag.offsetY));
      bar.style.left = `${nextLeft}px`;
      bar.style.top = `${nextTop}px`;
      bar.style.right = "auto";
      bar.style.bottom = "auto";
    });

    const finishDrag = () => {
      if (!drag) {
        return;
      }
      drag = null;
      const rect = bar.getBoundingClientRect();
      setScreenRecordBarPosition({ left: rect.left, top: rect.top });
    };

    bar.addEventListener("pointerup", finishDrag);
    bar.addEventListener("pointercancel", finishDrag);

    document.body.appendChild(bar);
    screenRecordBarEl = bar;
    updateScreenRecordBarLayout();
  }

  const isRecording = screenRecordStatus === "recording";
  const isPaused = screenRecordStatus === "paused";
  const isBusy = screenRecordStatus === "stopping";
  const elapsedText = formatElapsedTime(screenRecordElapsedMs);
  const canExpand = Boolean(screenRecordStatusText || screenRecorderLastSavedPath || screenRecordStatus === "error");
  const detailsOpen = screenRecordDetailsExpanded && canExpand;
  const statusTone = screenRecordStatus === "error" ? "#b42318" : screenRecordStatus === "saved" ? "#0f7b6c" : "#486581";
  const indicatorColor = isRecording ? "#d92d20" : isPaused ? "#d97706" : screenRecordStatus === "error" ? "#b42318" : "#98a2b3";
  const primaryButtonStyle =
    "display:inline-grid;place-items:center;width:18px;height:18px;border:0;border-radius:999px;background:rgba(148,163,184,0.2);color:#334e68;font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0;";
  const stopButtonStyle =
    "display:inline-grid;place-items:center;width:18px;height:18px;border:0;border-radius:999px;background:rgba(217,45,32,0.18);color:#b42318;font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0;";
  const chromeButtonStyle =
    "display:inline-grid;place-items:center;width:12px;height:12px;border:0;background:transparent;color:#334e68;font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0;";
  const disabledButtonStyle =
    "display:inline-grid;place-items:center;width:18px;height:18px;border:0;border-radius:999px;background:rgba(203,213,225,0.2);color:#98a2b3;font:inherit;font-size:11px;line-height:1;cursor:not-allowed;padding:0;";
  const disabledChromeButtonStyle =
    "display:inline-grid;place-items:center;width:12px;height:12px;border:0;background:transparent;color:#98a2b3;font:inherit;font-size:11px;line-height:1;cursor:not-allowed;padding:0;";

  screenRecordBarEl.innerHTML = [
    `<div style="display:flex;align-items:center;gap:4px;cursor:move;${detailsOpen ? "margin-bottom:4px;" : ""}">`,
    `<span style="display:inline-block;width:7px;height:7px;border-radius:999px;background:${indicatorColor};box-shadow:none;flex:0 0 auto;"></span>`,
    `<div style="min-width:46px;font-variant-numeric:tabular-nums;font-weight:700;color:${isRecording ? "#b42318" : isPaused ? "#b45309" : "#102a43"};">${elapsedText}</div>`,
    '<div style="display:flex;align-items:center;gap:4px;margin-left:2px;">',
    screenRecordStatus === "idle" || screenRecordStatus === "saved" || screenRecordStatus === "error"
      ? `<button type="button" data-start-screen-record title="Start recording" style="${isBusy ? disabledButtonStyle : primaryButtonStyle}">●</button>`
      : "",
    isRecording || isPaused
      ? `<button type="button" data-pause-screen-record title="${isPaused ? "Resume recording" : "Pause recording"}" style="${isBusy ? disabledButtonStyle : primaryButtonStyle}">${isPaused ? "▶" : "⏸"}</button>`
      : "",
    isRecording || isPaused || isBusy
      ? `<button type="button" data-stop-screen-record title="Stop and save recording" style="${isBusy ? disabledButtonStyle : stopButtonStyle}">■</button>`
      : "",
    canExpand
      ? `<button type="button" data-expand-screen-record title="${detailsOpen ? "Hide details" : "Show details"}" style="${chromeButtonStyle}">${detailsOpen ? "▴" : "▾"}</button>`
      : "",
    canCloseScreenRecordBar()
      ? `<button type="button" data-close-screen-record title="Hide" style="${chromeButtonStyle}">×</button>`
      : `<button type="button" title="Recording is active" disabled style="${disabledChromeButtonStyle}">×</button>`,
    "</div>",
    "</div>",
    detailsOpen
      ? [
          '<div style="margin-top:2px;padding:4px 6px 2px;border-top:1px solid rgba(148,163,184,0.35);border-radius:8px;background:rgba(255,255,255,0.2);max-width:300px;overflow-wrap:anywhere;">',
          '<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;font-size:10px;">',
          `<button type="button" data-screen-record-mode="native" title="Use native browser recording" style="border:0;border-radius:999px;padding:1px 6px;background:${screenRecordMode === "native" ? "rgba(148,163,184,0.24)" : "transparent"};color:#334e68;font:inherit;cursor:${screenRecordStatus === "idle" || screenRecordStatus === "saved" || screenRecordStatus === "error" ? "pointer" : "not-allowed"};">Native</button>`,
          `<button type="button" data-screen-record-mode="ffmpeg" title="Use FFmpeg recording" style="border:0;border-radius:999px;padding:1px 6px;background:${screenRecordMode === "ffmpeg" ? "rgba(148,163,184,0.24)" : "transparent"};color:#334e68;font:inherit;cursor:${screenRecordStatus === "idle" || screenRecordStatus === "saved" || screenRecordStatus === "error" ? "pointer" : "not-allowed"};">FFmpeg</button>`,
          "</div>",
          `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:${statusTone};">${screenRecordStatus}</div>`,
          `<div style="margin-top:2px;font-size:11px;color:#334e68;">${screenRecordStatusText || "No details"}</div>`,
          screenRecorderLastSavedPath
            ? `<div style="margin-top:4px;font-size:10px;color:#486581;">${screenRecorderLastSavedPath}</div>`
            : "",
          "</div>",
        ].join("")
      : "",
  ].join("");

  const closeButton = screenRecordBarEl.querySelector("[data-close-screen-record]");
  const startButton = screenRecordBarEl.querySelector("[data-start-screen-record]");
  const pauseButton = screenRecordBarEl.querySelector("[data-pause-screen-record]");
  const stopButton = screenRecordBarEl.querySelector("[data-stop-screen-record]");
  const expandButton = screenRecordBarEl.querySelector("[data-expand-screen-record]");
  const modeButtons = screenRecordBarEl.querySelectorAll("[data-screen-record-mode]");

  if (closeButton) {
    closeButton.addEventListener("click", () => {
      if (!canCloseScreenRecordBar()) {
        return;
      }

      setScreenRecordBarVisible(false);
      screenRecordDetailsExpanded = false;
      renderScreenRecordBar();
    });
  }

  if (startButton) {
    startButton.disabled = isBusy;
    startButton.addEventListener("click", () => {
      if (!isBusy) {
        startScreenRecording();
      }
    });
  }

  if (pauseButton) {
    pauseButton.disabled = isBusy;
    pauseButton.addEventListener("click", () => {
      if (isBusy) {
        return;
      }

      if (screenRecordStatus === "recording") {
        pauseScreenRecording();
      } else if (screenRecordStatus === "paused") {
        resumeScreenRecording();
      }
    });
  }

  if (stopButton) {
    stopButton.disabled = isBusy;
    stopButton.addEventListener("click", () => {
      if (!isBusy) {
        stopScreenRecording();
      }
    });
  }

  if (expandButton) {
    expandButton.addEventListener("click", () => {
      screenRecordDetailsExpanded = !screenRecordDetailsExpanded;
      renderScreenRecordBar();
    });
  }

  for (const modeButton of modeButtons) {
    modeButton.addEventListener("click", () => {
      if (!(screenRecordStatus === "idle" || screenRecordStatus === "saved" || screenRecordStatus === "error")) {
        return;
      }
      screenRecordMode = modeButton.dataset.screenRecordMode === "ffmpeg" ? "ffmpeg" : "native";
      writeShellState();
      renderScreenRecordBar();
    });
  }
}

function resetScreenRecordingSessionState() {
  screenRecorder = null;
  screenRecorderChunks = [];
  cleanupScreenRecorderStream();
  screenRecorderOutputPath = "";
  screenRecorderOutputDir = "";
  screenRecordStartedAt = 0;
  screenRecordElapsedMs = 0;
  screenRecordAccumulatedMs = 0;
  screenRecordPausedAt = 0;
  screenRecordBackend = null;
  stopScreenRecordTimer();
}

function createScreenRecordFinalizePromise() {
  if (screenRecordFinalizePromise) {
    return screenRecordFinalizePromise.promise;
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  screenRecordFinalizePromise = {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
  };
  return promise;
}

function resolveScreenRecordFinalize(value) {
  if (!screenRecordFinalizePromise) {
    return;
  }

  screenRecordFinalizePromise.resolve(value);
  screenRecordFinalizePromise = null;
}

function rejectScreenRecordFinalize(error) {
  if (!screenRecordFinalizePromise) {
    return;
  }

  screenRecordFinalizePromise.reject(error);
  screenRecordFinalizePromise = null;
}

async function stopScreenRecording() {
  if (screenRecordStatus === "stopping") {
    return screenRecordFinalizePromise?.promise || Promise.resolve();
  }

  if (!screenRecordBackend || (screenRecordStatus !== "recording" && screenRecordStatus !== "paused")) {
    return Promise.resolve();
  }

  const finalizePromise = createScreenRecordFinalizePromise();

  if (screenRecordBackend === "native" && screenRecordStatus === "paused") {
    try {
      screenRecorder.resume();
    } catch (_error) {}
  }

  isStoppingScreenRecorder = true;
  stopScreenRecordTimer();
  screenRecordElapsedMs =
    screenRecordStatus === "paused" ? screenRecordAccumulatedMs : screenRecordAccumulatedMs + (Date.now() - screenRecordStartedAt);
  setScreenRecordState("stopping", "Saving recording...");

  if (screenRecordBackend === "ffmpeg") {
    window.aivudaShell
      .stopFfmpegWindowRecording()
      .then((response) => {
        if (!response?.ok) {
          throw new Error(response?.error || "Failed to stop FFmpeg recording.");
        }
        screenRecorderLastSavedPath = response.outputPath || screenRecorderOutputPath;
        setScreenRecordState("saved", "Recording saved");
        isStoppingScreenRecorder = false;
        resetScreenRecordingSessionState();
        renderScreenRecordBar();
        resolveScreenRecordFinalize(response.outputPath);
      })
      .catch((error) => {
        isStoppingScreenRecorder = false;
        setScreenRecordState("error", `Record stop failed: ${error.message}`);
        screenRecordDetailsExpanded = true;
        rejectScreenRecordFinalize(error);
      });
    return finalizePromise;
  }

  try {
    screenRecorder.stop();
  } catch (error) {
    isStoppingScreenRecorder = false;
    setScreenRecordState("error", `Record stop failed: ${error.message}`);
    screenRecordDetailsExpanded = true;
    rejectScreenRecordFinalize(error);
  }

  return finalizePromise;
}

function pauseScreenRecording() {
  if (!screenRecordBackend || screenRecordStatus !== "recording") {
    return;
  }

  if (screenRecordBackend === "ffmpeg") {
    window.aivudaShell.pauseFfmpegWindowRecording().then((response) => {
      if (!response?.ok) {
        setScreenRecordState("error", `Pause failed: ${response?.error || "Unknown error"}`);
        screenRecordDetailsExpanded = true;
        return;
      }
      screenRecordAccumulatedMs += Date.now() - screenRecordStartedAt;
      screenRecordPausedAt = Date.now();
      screenRecordElapsedMs = screenRecordAccumulatedMs;
      stopScreenRecordTimer();
      setScreenRecordState("paused", "Recording paused");
    });
    return;
  }

  try {
    screenRecorder.pause();
    screenRecordAccumulatedMs += Date.now() - screenRecordStartedAt;
    screenRecordPausedAt = Date.now();
    screenRecordElapsedMs = screenRecordAccumulatedMs;
    stopScreenRecordTimer();
    setScreenRecordState("paused", "Recording paused");
  } catch (error) {
    setScreenRecordState("error", `Pause failed: ${error.message}`);
    screenRecordDetailsExpanded = true;
  }
}

function resumeScreenRecording() {
  if (!screenRecordBackend || screenRecordStatus !== "paused") {
    return;
  }

  if (screenRecordBackend === "ffmpeg") {
    window.aivudaShell.resumeFfmpegWindowRecording().then((response) => {
      if (!response?.ok) {
        setScreenRecordState("error", `Resume failed: ${response?.error || "Unknown error"}`);
        screenRecordDetailsExpanded = true;
        return;
      }
      screenRecordPausedAt = 0;
      screenRecordStartedAt = Date.now();
      startScreenRecordTimer();
      setScreenRecordState("recording", "Recording");
    });
    return;
  }

  try {
    screenRecorder.resume();
    screenRecordPausedAt = 0;
    screenRecordStartedAt = Date.now();
    startScreenRecordTimer();
    setScreenRecordState("recording", "Recording");
  } catch (error) {
    setScreenRecordState("error", `Resume failed: ${error.message}`);
    screenRecordDetailsExpanded = true;
  }
}

async function finalizeScreenRecording() {
  try {
    const blob = new Blob(screenRecorderChunks, { type: screenRecorder?.mimeType || "video/webm" });
    const arrayBuffer = await blob.arrayBuffer();
    const response = await window.aivudaShell.saveRecordingFile({
      outputPath: screenRecorderOutputPath,
      buffer: Array.from(new Uint8Array(arrayBuffer)),
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Failed to save recording.");
    }

    screenRecorderLastSavedPath = response.outputPath;
    setScreenRecordState("saved", "Recording saved");
    isStoppingScreenRecorder = false;
    resetScreenRecordingSessionState();
    renderScreenRecordBar();
    resolveScreenRecordFinalize(response.outputPath);
  } catch (error) {
    isStoppingScreenRecorder = false;
    setScreenRecordState("error", `Record save failed: ${error.message}`);
    screenRecordDetailsExpanded = true;
    cleanupScreenRecorderStream();
    screenRecorder = null;
    screenRecorderChunks = [];
    rejectScreenRecordFinalize(error);
    renderScreenRecordBar();
  }
}

function chooseScreenRecordingMimeType() {
  const candidates = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  for (const candidate of candidates) {
    if (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }

  return "";
}

async function startScreenRecording() {
  if (screenRecordStatus === "recording" || screenRecordStatus === "paused" || screenRecordStatus === "stopping") {
    return;
  }

  setScreenRecordBarVisible(true);
  screenRecordDetailsExpanded = false;
  screenRecorderLastSavedPath = "";
  renderScreenRecordBar();
  setScreenRecordState("idle", "Preparing window capture...");

  if (screenRecordMode === "ffmpeg") {
    try {
      const prepared = await window.aivudaShell.startFfmpegWindowRecording();
      if (!prepared?.ok || !prepared.outputPath) {
        throw new Error(prepared?.error || "Could not start FFmpeg window capture.");
      }

      screenRecordBackend = "ffmpeg";
      screenRecorderOutputPath = prepared.outputPath;
      screenRecorderOutputDir = prepared.recordingsDir || "";
      screenRecordStartedAt = Date.now();
      screenRecordAccumulatedMs = 0;
      screenRecordPausedAt = 0;
      screenRecordElapsedMs = 0;
      startScreenRecordTimer();
      setScreenRecordState("recording", "Recording with FFmpeg");
      return;
    } catch (error) {
      resetScreenRecordingSessionState();
      setScreenRecordState("error", `Record start failed: ${error.message}`);
      screenRecordDetailsExpanded = true;
      return;
    }
  }

  try {
    const prepared = await window.aivudaShell.prepareWindowRecording();
    if (!prepared?.ok || !prepared.sourceId || !prepared.outputPath) {
      throw new Error(prepared?.error || "Could not prepare window capture.");
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: prepared.sourceId,
        },
      },
    });

    const mimeType = chooseScreenRecordingMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    screenRecorderChunks = [];
    screenRecordBackend = "native";
    screenRecorder = recorder;
    screenRecorderStream = stream;
    screenRecorderOutputPath = prepared.outputPath;
    screenRecorderOutputDir = prepared.recordingsDir || "";
    screenRecordStartedAt = Date.now();
    screenRecordAccumulatedMs = 0;
    screenRecordPausedAt = 0;
    screenRecordElapsedMs = 0;

    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) {
        screenRecorderChunks.push(event.data);
      }
    });

    recorder.addEventListener("stop", () => {
      finalizeScreenRecording();
    });

    recorder.addEventListener("error", (event) => {
      const message = event?.error?.message || "Recording failed.";
      isStoppingScreenRecorder = false;
      setScreenRecordState("error", `Record failed: ${message}`);
      screenRecordDetailsExpanded = true;
      resetScreenRecordingSessionState();
      rejectScreenRecordFinalize(new Error(message));
    });

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (screenRecordStatus === "recording" || screenRecordStatus === "paused") {
          stopScreenRecording();
        }
      });
    }

    recorder.start(1000);
    startScreenRecordTimer();
    setScreenRecordState("recording", "Recording");
  } catch (error) {
    resetScreenRecordingSessionState();
    setScreenRecordState("error", `Record start failed: ${error.message}`);
    screenRecordDetailsExpanded = true;
  }
}

function showScreenRecordBar() {
  setScreenRecordBarVisible(true);
  renderScreenRecordBar();
}

async function finalizeActiveRecordingBeforeClose() {
  if (screenRecordStatus !== "recording" && screenRecordStatus !== "paused" && screenRecordStatus !== "stopping") {
    return { ok: true };
  }

  try {
    await stopScreenRecording();
    return { ok: true, outputPath: screenRecorderLastSavedPath };
  } catch (error) {
    screenRecordDetailsExpanded = true;
    renderScreenRecordBar();
    return {
      ok: false,
      error: error?.message || "Failed to finalize recording before close.",
    };
  }
}

window.__aivudaFinalizeActiveRecordingBeforeClose = finalizeActiveRecordingBeforeClose;

function toggleScreenRecordBar() {
  showScreenRecordBar();
}

function createTab(rawUrl, options = {}) {
  const id = options.id || `tab-${nextTabId}`;
  const numericId = Number(String(id).replace(/^tab-/, ""));
  if (Number.isFinite(numericId)) {
    nextTabId = Math.max(nextTabId, numericId + 1);
  } else {
    nextTabId += 1;
  }

  const url = normalizeUrlInput(rawUrl);
  const webview = document.createElement("webview");
  webview.src = url;
  webview.setAttribute("partition", "persist:aivuda-shell");
  webview.setAttribute("preload", guestPreloadUrl);

  const tab = {
    id,
    title: "Loading...",
    url,
    webview,
    button: null,
  };

  tab.button = createTabButton(tab);
  tabs.set(id, tab);
  stackEl.appendChild(webview);
  writeShellState();

  webview.addEventListener("dom-ready", () => {
    if (typeof webview.getWebContentsId === "function") {
      window.aivudaShell.registerWebview(webview.getWebContentsId());
    }
    if (performanceOverlayVisible) {
      injectPerformanceOverlay(tab, "show");
    }
  });

  webview.addEventListener("ipc-message", (event) => {
    if (event.channel === "aivuda-shell:open-url-in-new-tab") {
      const [nextUrl] = event.args;
      if (typeof nextUrl === "string" && nextUrl.trim()) {
        createTab(nextUrl);
      }
      return;
    }

    if (event.channel === "aivuda-shell:set-performance-overlay-visible") {
      const [isVisible] = event.args;
      if (typeof isVisible === "boolean") {
        setPerformanceOverlayVisible(isVisible);
      }
    }
  });

  webview.addEventListener("did-start-loading", () => {
    setStatus("Loading");
    updateTabTitle(tab, "Loading...");
  });

  webview.addEventListener("did-stop-loading", () => {
    tab.url = getTabUrl(tab);
    if (tab.id === activeTabId) {
      setStatus("Ready");
      updateAddressFromActiveTab();
      updateNavigationState();
    }
    writeShellState();
  });

  webview.addEventListener("did-navigate", () => {
    tab.url = getTabUrl(tab);
    if (tab.id === activeTabId) {
      updateAddressFromActiveTab();
      updateNavigationState();
    }
    writeShellState();
  });

  webview.addEventListener("did-navigate-in-page", () => {
    tab.url = getTabUrl(tab);
    if (tab.id === activeTabId) {
      updateAddressFromActiveTab();
      updateNavigationState();
    }
    writeShellState();
  });

  webview.addEventListener("page-title-updated", (event) => {
    updateTabTitle(tab, event.title);
  });

  webview.addEventListener("did-fail-load", (event) => {
    if (!event.isMainFrame || event.validatedURL.startsWith("file://")) {
      return;
    }

    const params = new URLSearchParams({
      url: event.validatedURL || tab.url,
      error: `${event.errorDescription} (${event.errorCode})`,
    });
    webview.src = `${offlineUrl}?${params.toString()}`;
  });
  activateTab(id);
}

function activateTab(id) {
  if (!tabs.has(id)) {
    return;
  }

  activeTabId = id;
  updateActiveClasses();
  updateAddressFromActiveTab();
  updateNavigationState();
  syncPerformanceOverlayForActiveTab();
  writeShellState();
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) {
    return;
  }

  tab.button.remove();
  tab.webview.remove();
  tabs.delete(id);
  writeShellState();

  if (activeTabId === id) {
    const next = tabs.keys().next().value;
    activeTabId = next || null;
    if (next) {
      activateTab(next);
    } else {
      createTab(defaultUrl);
    }
  }
}

function reloadActiveTab() {
  const tab = getActiveTab();
  if (tab) {
    tab.webview.reload();
  }
}

function navigateActiveTab(rawUrl) {
  const tab = getActiveTab();
  if (!tab) {
    return;
  }

  const nextUrl = normalizeUrlInput(rawUrl);
  tab.url = nextUrl;
  tab.webview.src = nextUrl;
  updateAddressFromActiveTab();
  writeShellState();
}

collapseChromeButton.addEventListener("click", () => {
  setChromeExpanded(false);
});

newTabButton.addEventListener("click", () => {
  setChromeExpanded(true);
  createTab(defaultUrl);
});

reloadButton.addEventListener("click", reloadActiveTab);

backButton.addEventListener("click", () => {
  const tab = getActiveTab();
  if (tab?.webview.canGoBack()) {
    tab.webview.goBack();
  }
});

forwardButton.addEventListener("click", () => {
  const tab = getActiveTab();
  if (tab?.webview.canGoForward()) {
    tab.webview.goForward();
  }
});

addressInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    navigateActiveTab(addressInput.value);
  }
});

window.aivudaShell.onNewTab((payload) => createTab(payload?.url || defaultUrl));
window.aivudaShell.onOpenUrlInNewTab((payload) => {
  createTab(payload?.url || defaultUrl);
});
window.aivudaShell.onCloseCurrentTab(() => {
  if (activeTabId) {
    closeTab(activeTabId);
  }
});
window.aivudaShell.onReloadCurrentTab(reloadActiveTab);
window.aivudaShell.onShowBrowserChrome(() => {
  setChromeExpanded(true);
  addressInput.focus();
  addressInput.select();
});
window.aivudaShell.onHideBrowserChrome(() => {
  setChromeExpanded(false);
});
window.aivudaShell.onToggleBrowserChrome(() => {
  const isExpanded = shellEl.classList.contains("expanded");
  setChromeExpanded(!isExpanded);
  if (!isExpanded) {
    addressInput.focus();
    addressInput.select();
  }
});
window.aivudaShell.onToggleDevtools(() => {
  const tab = getActiveTab();
  if (tab) {
    tab.webview.isDevToolsOpened() ? tab.webview.closeDevTools() : tab.webview.openDevTools();
  }
});
window.aivudaShell.onShowPerformanceOverlay(() => {
  setPerformanceOverlayVisible(true);
  syncPerformanceOverlayForActiveTab();
});
window.aivudaShell.onHidePerformanceOverlay(() => {
  setPerformanceOverlayVisible(false);
  syncPerformanceOverlayForActiveTab();
});
window.aivudaShell.onTogglePerformanceOverlay(() => {
  setPerformanceOverlayVisible(!performanceOverlayVisible);
  syncPerformanceOverlayForActiveTab();
});
window.aivudaShell.onToggleScreenRecordBar(() => {
  showScreenRecordBar();
});
window.aivudaShell.onClearBrowserData(async () => {
  await window.aivudaShell.clearBrowserData();
  window.location.reload();
});

window.addEventListener("pagehide", () => {
  writeShellState();
});

window.setInterval(() => {
  writeShellState();
}, shellStateAutosaveIntervalMs);

window.aivudaShell.getStartup().then((startup) => {
  defaultUrl = startup.defaultUrl || defaultUrl;
  const savedState = normalizeSavedShellState(startup.savedState);
  if (savedState) {
    performanceOverlayVisible = savedState.performanceOverlayVisible;
    screenRecordBarVisible = savedState.screenRecordBarVisible;
    screenRecordMode = savedState.screenRecordMode;
    screenRecordBarPosition = savedState.screenRecordBarPosition;
    setChromeExpanded(savedState.chromeExpanded);
    const restoredTabs = savedState.tabs.length > 0 ? savedState.tabs : [{ url: startup.initialUrl || defaultUrl }];
    for (const tabState of restoredTabs) {
      createTab(tabState.url, { id: tabState.id });
    }
    if (savedState.activeTabId && tabs.has(savedState.activeTabId)) {
      activateTab(savedState.activeTabId);
    }
    renderScreenRecordBar();
    finishShellStateRestore();
    return;
  }

  createTab(startup.initialUrl || defaultUrl);
  renderScreenRecordBar();
  finishShellStateRestore();
});

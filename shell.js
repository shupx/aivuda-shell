const shellEl = document.getElementById("shell");
const tabsEl = document.getElementById("tabs");
const stackEl = document.getElementById("webview-stack");
const addressInput = document.getElementById("address-input");
const statusText = document.getElementById("status-text");
const expandChromeButton = document.getElementById("expand-chrome");
const collapseChromeButton = document.getElementById("collapse-chrome");
const newTabButton = document.getElementById("new-tab");
const backButton = document.getElementById("back-button");
const forwardButton = document.getElementById("forward-button");
const reloadButton = document.getElementById("reload-button");

let defaultUrl = "http://127.0.0.1:80";
let activeTabId = null;
let nextTabId = 1;
const tabs = new Map();
const guestPreloadUrl = new URL("guest-preload.js", window.location.href).toString();
const offlineUrl = new URL("offline.html", window.location.href).toString();

function setChromeExpanded(isExpanded) {
  shellEl.classList.toggle("expanded", isExpanded);
  expandChromeButton.textContent = isExpanded ? "⌃" : "☰";
  expandChromeButton.title = isExpanded ? "Hide tabs and address bar" : "Show tabs and address bar";
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
}

function updateAddressFromActiveTab() {
  const tab = getActiveTab();
  addressInput.value = tab ? tab.webview.getURL() || tab.url : "";
}

function updateNavigationState() {
  const tab = getActiveTab();
  backButton.disabled = !tab || !tab.webview.canGoBack();
  forwardButton.disabled = !tab || !tab.webview.canGoForward();
}

function updateActiveClasses() {
  for (const tab of tabs.values()) {
    const isActive = tab.id === activeTabId;
    tab.button.classList.toggle("active", isActive);
    tab.button.setAttribute("aria-selected", String(isActive));
    tab.webview.classList.toggle("hidden", !isActive);
  }
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
            "min-width:82px",
            "max-width:240px",
            "padding:6px 8px",
            "border:1px solid rgba(148,163,184,0.48)",
            "border-radius:6px",
            "background:rgba(255,255,255,0.72)",
            "color:#102a43",
            "font:11px/1.35 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
            "box-shadow:0 8px 20px rgba(15,23,42,0.12)",
            "backdrop-filter:blur(8px)",
            "cursor:move",
            "user-select:none"
          ].join(";");

          overlay.innerHTML = [
            '<div style="display:flex;align-items:center;gap:6px;">',
            '<span style="font-weight:700;">FPS</span>',
            '<span data-fps>--</span>',
            '<button type="button" data-gpu-toggle title="GPU details" style="width:20px;height:20px;border:0;border-radius:4px;background:rgba(148,163,184,0.22);color:#334e68;font:inherit;line-height:1;cursor:pointer;">▾</button>',
            '<button type="button" data-close title="Hide" style="width:20px;height:20px;border:0;border-radius:4px;background:transparent;color:#52606d;font:inherit;line-height:1;cursor:pointer;">×</button>',
            '</div>',
            '<div data-gpu-row style="display:none;margin-top:5px;max-width:220px;overflow-wrap:anywhere;color:#334e68;">GPU: <span data-gpu>Checking...</span></div>'
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
          closeButton.addEventListener("click", () => overlay.remove());
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
    console.warn("[aivuda-electron-shell] failed to inject performance overlay", error);
  });
}

function createTab(rawUrl) {
  const id = `tab-${nextTabId}`;
  nextTabId += 1;

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

  webview.addEventListener("dom-ready", () => {
    if (typeof webview.getWebContentsId === "function") {
      window.aivudaShell.registerWebview(webview.getWebContentsId());
    }
  });

  webview.addEventListener("ipc-message", (event) => {
    if (event.channel !== "aivuda-shell:open-url-in-new-tab") {
      return;
    }

    const [nextUrl] = event.args;
    if (typeof nextUrl === "string" && nextUrl.trim()) {
      createTab(nextUrl);
    }
  });

  webview.addEventListener("did-start-loading", () => {
    setStatus("Loading");
    updateTabTitle(tab, "Loading...");
  });

  webview.addEventListener("did-stop-loading", () => {
    if (tab.id === activeTabId) {
      setStatus("Ready");
      updateAddressFromActiveTab();
      updateNavigationState();
    }
  });

  webview.addEventListener("did-navigate", () => {
    if (tab.id === activeTabId) {
      updateAddressFromActiveTab();
      updateNavigationState();
    }
  });

  webview.addEventListener("did-navigate-in-page", () => {
    if (tab.id === activeTabId) {
      updateAddressFromActiveTab();
      updateNavigationState();
    }
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
}

function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) {
    return;
  }

  tab.button.remove();
  tab.webview.remove();
  tabs.delete(id);

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
}

expandChromeButton.addEventListener("click", () => {
  setChromeExpanded(!shellEl.classList.contains("expanded"));
});

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
window.aivudaShell.onToggleDevtools(() => {
  const tab = getActiveTab();
  if (tab) {
    tab.webview.isDevToolsOpened() ? tab.webview.closeDevTools() : tab.webview.openDevTools();
  }
});
window.aivudaShell.onShowPerformanceOverlay(() => {
  injectPerformanceOverlay(getActiveTab(), "show");
});
window.aivudaShell.onHidePerformanceOverlay(() => {
  injectPerformanceOverlay(getActiveTab(), "hide");
});
window.aivudaShell.onTogglePerformanceOverlay(() => {
  injectPerformanceOverlay(getActiveTab(), "toggle");
});

window.aivudaShell.getStartup().then((startup) => {
  defaultUrl = startup.defaultUrl || defaultUrl;
  createTab(startup.initialUrl || defaultUrl);
});

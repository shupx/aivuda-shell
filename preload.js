const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aivudaShell", {
  clearBrowserData: () => ipcRenderer.invoke("aivuda-shell:clear-browser-data"),
  getGpuStatus: () => ipcRenderer.invoke("aivuda-shell:get-gpu-status"),
  getStartup: () => ipcRenderer.invoke("aivuda-shell:get-startup"),
  prepareWindowRecording: () => ipcRenderer.invoke("aivuda-shell:prepare-window-recording"),
  saveShellState: (state) => ipcRenderer.invoke("aivuda-shell:save-shell-state", state),
  saveRecordingFile: (payload) => ipcRenderer.invoke("aivuda-shell:save-recording-file", payload),
  onCloseCurrentTab: (callback) => ipcRenderer.on("aivuda-shell:close-current-tab", callback),
  onClearBrowserData: (callback) => ipcRenderer.on("aivuda-shell:clear-browser-data", callback),
  onHideBrowserChrome: (callback) => ipcRenderer.on("aivuda-shell:hide-browser-chrome", callback),
  onHidePerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:hide-performance-overlay", callback),
  onNewTab: (callback) => ipcRenderer.on("aivuda-shell:new-tab", (_event, payload) => callback(payload)),
  onOpenUrlInNewTab: (callback) => ipcRenderer.on("aivuda-shell:open-url-in-new-tab", (_event, payload) => callback(payload)),
  onReloadCurrentTab: (callback) => ipcRenderer.on("aivuda-shell:reload-current-tab", callback),
  onShowPerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:show-performance-overlay", callback),
  onShowBrowserChrome: (callback) => ipcRenderer.on("aivuda-shell:show-browser-chrome", callback),
  onToggleScreenRecordBar: (callback) => ipcRenderer.on("aivuda-shell:toggle-screen-record-bar", callback),
  onToggleBrowserChrome: (callback) => ipcRenderer.on("aivuda-shell:toggle-browser-chrome", callback),
  onToggleDevtools: (callback) => ipcRenderer.on("aivuda-shell:toggle-devtools", callback),
  onTogglePerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:toggle-performance-overlay", callback),
  registerWebview: (guestInstanceId) => ipcRenderer.send("aivuda-shell:register-webview", guestInstanceId),
});

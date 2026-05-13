const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aivudaShell", {
  getStartup: () => ipcRenderer.invoke("aivuda-shell:get-startup"),
  onCloseCurrentTab: (callback) => ipcRenderer.on("aivuda-shell:close-current-tab", callback),
  onHidePerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:hide-performance-overlay", callback),
  onNewTab: (callback) => ipcRenderer.on("aivuda-shell:new-tab", (_event, payload) => callback(payload)),
  onReloadCurrentTab: (callback) => ipcRenderer.on("aivuda-shell:reload-current-tab", callback),
  onShowPerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:show-performance-overlay", callback),
  onToggleDevtools: (callback) => ipcRenderer.on("aivuda-shell:toggle-devtools", callback),
  onTogglePerformanceOverlay: (callback) => ipcRenderer.on("aivuda-shell:toggle-performance-overlay", callback),
});

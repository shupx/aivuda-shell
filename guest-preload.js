const { ipcRenderer } = require("electron");

window.addEventListener("aivuda-shell:set-performance-overlay-visible", (event) => {
  const isVisible = event?.detail?.visible;
  if (typeof isVisible !== "boolean") {
    return;
  }

  ipcRenderer.sendToHost("aivuda-shell:set-performance-overlay-visible", isVisible);
});

#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageRoot = path.join(__dirname, "..");
const desktopDir = path.join(os.homedir(), ".local", "share", "applications");
const desktopFilePath = path.join(desktopDir, "aivuda-shell.desktop");
const iconPath = path.join(packageRoot, "assets", "aivuda_icon.png");
const cliPath = path.join(__dirname, "aivuda-shell.js");

if (process.platform !== "linux") {
  console.error("[aivuda-shell] desktop launcher installation is only supported on Linux.");
  process.exit(1);
}

fs.mkdirSync(desktopDir, { recursive: true });

const desktopEntry = [
  "[Desktop Entry]",
  "Version=1.0",
  "Type=Application",
  "Name=AivudaOS",
  "Comment=Launch the AivudaOS Electron Shell",
  `Exec=${cliPath}`,
  `Icon=${iconPath}`,
  "Terminal=false",
  "Categories=Utility;",
  "StartupNotify=true",
].join("\n");

fs.writeFileSync(desktopFilePath, `${desktopEntry}\n`, "utf8");
fs.chmodSync(desktopFilePath, 0o755);

console.log(`[aivuda-shell] desktop launcher installed at ${desktopFilePath}`);

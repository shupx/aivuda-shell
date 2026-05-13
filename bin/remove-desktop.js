#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktopFilePath = path.join(os.homedir(), ".local", "share", "applications", "aivuda-shell.desktop");

if (process.platform !== "linux") {
  console.error("[aivuda-shell] desktop launcher removal is only supported on Linux.");
  process.exit(1);
}

try {
  fs.rmSync(desktopFilePath, { force: true });
  console.log(`[aivuda-shell] desktop launcher removed from ${desktopFilePath}`);
} catch (error) {
  console.error("[aivuda-shell] failed to remove desktop launcher:", error.message);
  process.exit(1);
}

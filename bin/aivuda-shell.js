#!/usr/bin/env node

const path = require("node:path");
const { spawn } = require("node:child_process");

const electronBinary = require("electron");
const packageRoot = path.join(__dirname, "..");
const extraArgs = process.argv.slice(2);

const child = spawn(electronBinary, [packageRoot, ...extraArgs], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[aivuda-shell] failed to launch Electron:", error.message);
  process.exit(1);
});

#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const child = spawn(join(__dirname, "axi-native"), process.argv.slice(2), { stdio: "inherit" });
const forwardInterrupt = () => child.kill("SIGINT");
const forwardTermination = () => child.kill("SIGTERM");
process.on("SIGINT", forwardInterrupt);
process.on("SIGTERM", forwardTermination);
child.once("error", error => {
  console.error(`Could not start Axi: ${error.message}`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.removeListener("SIGINT", forwardInterrupt);
  process.removeListener("SIGTERM", forwardTermination);
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});

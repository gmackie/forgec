#!/usr/bin/env node
// Generic Forge API CLI: see src/cli.ts for the machine contract.
import { runCli } from "../dist/cli.js";

const stdin = () => new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve("");
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { data += c; });
  process.stdin.on("end", () => resolve(data));
});
const code = await runCli(process.argv.slice(2), { stdin, stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env, fetch });
process.exitCode = code;

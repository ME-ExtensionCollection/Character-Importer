#!/usr/bin/env node
// Char Importer: stops Marinara when an import queue asks for it.
//
// Marinara can't stop itself from the page, so the queue's "Turn off
// Marinara when done" box writes a request to Char Importer's storage on the
// Marinara server, and this script (running on the same computer) polls it
// and stops Marinara with SIGINT, the same as Ctrl+C, so saves are flushed.
//
// Usage:
//   node tools/shutdown-watcher.mjs <sync address>
//       watch the Marinara already running: the process listening on the
//       address's port (Linux, or wherever lsof exists), found when it's time
//   node tools/shutdown-watcher.mjs <sync address> -- <command that starts Marinara...>
//       start Marinara through the watcher
//   node tools/shutdown-watcher.mjs <sync address> --pid <process id of Marinara>
// Options:
//   --cwd <folder>      folder to run the command in (default: the current one),
//                       e.g. Marinara's folder for "pnpm start"
//   --then "<command>"  run after Marinara has stopped, e.g. "systemctl poweroff"
//   --every <seconds>   how often to check (default 10)
//   --insecure          accept a self-signed certificate on a non-local address
//                       (always accepted for 127.0.0.1 / localhost)
//
// <sync address> is the one under Tools > Companion userscript > "Chub in
// another browser". Use 127.0.0.1 as its host so no login is needed.
// Only requests made after this script started count. The script uses no
// packages and writes nothing; the command runs exactly as if typed there.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import http from "node:http";
import https from "node:https";

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error("Usage: node tools/shutdown-watcher.mjs <sync address> [-- <command...> | --pid <pid>] [--cwd <folder>] [--then \"<command>\"] [--every <s>] [--insecure]");
  process.exit(2);
}

const argv = process.argv.slice(2);
const dashes = argv.indexOf("--");
const own = dashes >= 0 ? argv.slice(0, dashes) : argv;
const command = dashes >= 0 ? argv.slice(dashes + 1) : [];
let address = "";
let pid = 0;
let then = "";
let every = 10;
let insecure = false;
let cwd = process.cwd();
for (let i = 0; i < own.length; i++) {
  const arg = own[i];
  if (arg === "--pid") pid = Number(own[++i]);
  else if (arg === "--then") then = own[++i] ?? "";
  else if (arg === "--every") every = Number(own[++i]);
  else if (arg === "--insecure") insecure = true;
  else if (arg === "--cwd") cwd = own[++i] ?? "";
  else if (arg === "-h" || arg === "--help") usage();
  else if (!address) address = arg;
  else usage(`Unexpected argument: ${arg}`);
}
if (!address) usage("No sync address");
let url;
try {
  url = new URL(address);
} catch {
  usage(`Not an address: ${address}`);
}
if (!/\/api\/personal-extensions\/[^/]+\/storage$/.test(url.pathname)) usage("That isn't Char Importer's sync address (it ends in /storage)");
if (command.length && pid) usage("Use either -- <command> or --pid, not both");
if (own.includes("--pid") && !(pid > 0)) usage("--pid needs a process id");
// Neither: find the running Marinara by the port it listens on
const auto = !command.length && !pid;
const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
if (!(every >= 2)) usage("--every must be at least 2 seconds");
if (!cwd) usage("--cwd needs a folder");

const isLocal = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
const startedAt = Date.now();
const log = (text) => console.log(`[shutdown-watcher ${new Date().toLocaleTimeString()}] ${text}`);

function readStorage() {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, { headers: { Accept: "application/json" }, rejectUnauthorized: !(isLocal || insecure), timeout: 15_000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`Marinara answered ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? " (use 127.0.0.1 as the host)" : ""}`));
        try {
          resolve(JSON.parse(body)?.value ?? {});
        } catch {
          reject(new Error("Not JSON"));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("No answer")));
    req.on("error", reject);
  });
}

/** Process listening on a TCP port on this computer, or 0. */
function listenerPid(onPort) {
  if (process.platform === "linux") {
    const inodes = new Set();
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        // local_address is IP:PORT in hex; state 0A is LISTEN; column 9 is the socket inode
        if (cols.length > 9 && parseInt(cols[1].split(":")[1], 16) === onPort && cols[3] === "0A") inodes.add(cols[9]);
      }
    }
    if (!inodes.size) return 0;
    for (const dir of readdirSync("/proc")) {
      if (!/^\d+$/.test(dir)) continue;
      let fds = [];
      try {
        fds = readdirSync(`/proc/${dir}/fd`);
      } catch {
        continue; // another user's process
      }
      for (const fd of fds) {
        try {
          const target = readlinkSync(`/proc/${dir}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
          if (target && inodes.has(target[1])) return Number(dir);
        } catch {
          // closed meanwhile
        }
      }
    }
    return 0;
  }
  try {
    return Number(execFileSync("lsof", ["-nP", `-iTCP:${onPort}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).split("\n")[0]) || 0;
  } catch {
    return 0;
  }
}

/** "node" etc., where the system says (Linux). */
function processName(id) {
  try {
    return readFileSync(`/proc/${id}/comm`, "utf8").trim();
  } catch {
    return "";
  }
}

let child = null;
let childExited = null;
if (command.length) {
  child = spawn(command[0], command.slice(1), { stdio: "inherit", cwd });
  childExited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(code ?? signal)));
  child.on("error", (error) => {
    console.error(`Could not start ${command[0]}: ${error.message}`);
    process.exit(1);
  });
  // Marinara stopped some other way (Ctrl+C in this terminal reaches it too): nothing left to watch
  childExited.then((result) => {
    if (!stopping) {
      log(`Marinara exited (${result}); stopping the watcher.`);
      process.exit(0);
    }
  });
  pid = child.pid;
}

const alive = (id) => {
  try {
    process.kill(id, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitForExit(ms) {
  if (childExited) return Promise.race([childExited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !alive(pid);
}

let stopping = false;
async function stopMarinara() {
  stopping = true;
  if (auto) {
    // Found now, so a Marinara restarted since the watcher started is the one stopped
    pid = listenerPid(port);
    if (!pid) {
      log(`Nothing is listening on port ${port} that this user may stop (in Docker or run as another user, use --pid or stop it there).`);
      process.exit(1);
    }
    const name = processName(pid);
    if (name && !/node/i.test(name)) log(`Note: the process on port ${port} is "${name}", not node.`);
  }
  log(`Stopping Marinara (pid ${pid}) with SIGINT...`);
  try {
    process.kill(pid, "SIGINT");
  } catch (error) {
    log(`Could not signal it: ${error.message}`);
  }
  if (!(await waitForExit(60_000))) {
    log("Still running after 60 s; sending SIGTERM.");
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone
    }
    await waitForExit(15_000);
  }
  log("Marinara stopped.");
  if (then) {
    log(`Running: ${then}`);
    const after = spawn(then, { stdio: "inherit", shell: true });
    after.on("exit", (code) => process.exit(code ?? 0));
  } else {
    process.exit(0);
  }
}

let lastError = "";
async function check() {
  if (stopping) return;
  if (!child && !auto && !alive(pid)) {
    log(`Process ${pid} isn't running; stopping the watcher.`);
    process.exit(0);
  }
  try {
    const value = await readStorage();
    if (lastError) log("Reached Marinara again.");
    lastError = "";
    const at = Number(value?.shutdownRequest?.at) || 0;
    if (at > startedAt) {
      log(`The import queue asked to turn Marinara off (${new Date(at).toLocaleTimeString()}).`);
      await stopMarinara();
      return;
    }
  } catch (error) {
    // Normal while Marinara is still starting
    if (error.message !== lastError) log(`Can't read the request yet: ${error.message}`);
    lastError = error.message;
  }
  setTimeout(check, every * 1000);
}

if (auto) {
  const found = listenerPid(port);
  const name = found ? processName(found) : "";
  log(
    found
      ? `Watching ${url.origin} every ${every} s. Marinara is pid ${found}${name ? ` (${name})` : ""}, listening on port ${port}${then ? `; then: ${then}` : ""}.`
      : `Watching ${url.origin} every ${every} s. Nothing this user may stop is listening on port ${port} yet; it's looked up again when it's time.`,
  );
} else {
  log(`Watching ${url.origin} every ${every} s for Marinara (pid ${pid})${then ? `, then: ${then}` : ""}.`);
}
setTimeout(check, command.length ? 5000 : 0);

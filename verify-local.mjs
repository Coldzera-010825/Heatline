import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const base = "http://127.0.0.1:8788";
const cwd = new URL(".", import.meta.url);
const server = spawn(process.execPath, ["serve-local.mjs"], { cwd, stdio: "inherit" });
const closed = once(server, "close");

try {
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("The local server stopped before the checks ran.");
    ready = await fetch(base, { method: "HEAD", signal: AbortSignal.timeout(800) })
      .then(response => response.ok, () => false);
    if (!ready) await delay(120);
  }
  if (!ready) throw new Error("The local server did not start.");
  const check = spawn(process.execPath, ["test-admin-api.mjs", base], { cwd, stdio: "inherit" });
  const [status] = await once(check, "close");
  if (status !== 0) process.exitCode = status ?? 1;
} finally {
  if (server.exitCode === null && server.signalCode === null) server.kill();
  await closed;
}

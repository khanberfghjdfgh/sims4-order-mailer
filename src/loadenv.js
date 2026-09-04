// Minimal .env loader (no external dependency). Loads KEY=VALUE lines from
// a .env file next to the package root if present. Never overrides variables
// already set in the environment (keeping platform env vars authoritative).
import fs from "fs";
import path from "path";

export function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (/^".*"$/.test(val)) val = val.slice(1, -1);
    else {
      const idx = val.indexOf(" #");
      if (idx !== -1) val = val.slice(0, idx).trim();
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
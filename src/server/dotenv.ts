/** Minimal .env loader (KEY=VALUE, # comments, optional quotes). Does not override existing env. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadDotenv(file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env")) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

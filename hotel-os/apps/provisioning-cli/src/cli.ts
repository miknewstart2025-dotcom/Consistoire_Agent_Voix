#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { plan } from "./steps";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const serverUrl = arg("server");
const token = arg("token");
const dpcApk = arg("dpc");
if (!serverUrl || !token || !dpcApk) {
  console.error("usage: hotelos-provision --server https://api.example.com --token <enrollment token> --dpc dpc.apk [--launcher launcher.apk] [--serial <adb serial>]");
  process.exit(2);
}
for (const f of [dpcApk, arg("launcher")].filter(Boolean) as string[]) if (!existsSync(f)) { console.error(`file not found: ${f}`); process.exit(2); }

for (const step of plan({ serial: arg("serial"), dpcApk, launcherApk: arg("launcher"), serverUrl, token })) {
  process.stdout.write(`• ${step.name} … `);
  let out: string;
  try {
    out = execFileSync("adb", step.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
    const why = step.check?.(out) ?? out.trim();
    console.log("FAILED");
    console.error(`  ${why}`);
    process.exit(1);
  }
  const problem = step.check?.(out) ?? null;
  if (problem) { console.log("FAILED"); console.error(`  ${problem}`); process.exit(1); }
  console.log("ok");
}
console.log("\nProvisioned. The TV now shows a 6-character pairing code: assign it to a room in HOTEL MANAGER → Technicien.");

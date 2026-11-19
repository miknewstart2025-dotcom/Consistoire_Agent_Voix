/**
 * Usage: node dist/cli.js --server http://localhost:3001 --token <enrollment token> [--count 100] [--duration 60]
 * Enrolls N simulated boxes, keeps WebSockets open, prints latency stats. For load & protocol testing.
 */
import { SimDevice } from "./sim-device";

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const server = arg("server", "http://localhost:3001")!;
  const token = arg("token");
  const count = Number(arg("count", "1"));
  const duration = Number(arg("duration", "0"));
  if (!token) throw new Error("--token <enrollment token> is required (max uses ≥ count)");
  const devices: SimDevice[] = [];
  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const d = new SimDevice(server, `sim-${i}`);
    const r = await d.enroll(token);
    await d.sync();
    await d.connect();
    devices.push(d);
    if (count <= 10) console.log(`device ${r.deviceId} enrolled – pairing code ${r.pairingCode}`);
  }
  console.log(`${count} simulated devices enrolled and connected in ${Date.now() - t0} ms`);
  const hb = setInterval(() => devices.forEach((d) => d.heartbeat()), 30_000);
  const stop = () => {
    clearInterval(hb);
    const tot = devices.reduce((a, d) => ({ commands: a.commands + d.stats.commands, policies: a.policies + d.stats.policies, errors: a.errors + d.stats.errors }), { commands: 0, policies: 0, errors: 0 });
    console.log(`stats: ${JSON.stringify(tot)}`);
    devices.forEach((d) => d.close());
    process.exit(tot.errors ? 1 : 0);
  };
  if (duration > 0) setTimeout(stop, duration * 1000);
  process.on("SIGINT", stop);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

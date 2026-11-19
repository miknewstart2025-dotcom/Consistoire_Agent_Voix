import { createApp } from "./bootstrap";
import { loadConfig } from "./config";

async function main() {
  const cfg = loadConfig();
  const app = await createApp(cfg);
  await app.listen(cfg.PORT, "0.0.0.0");
  console.log(`HOTEL OS API listening on :${cfg.PORT}`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

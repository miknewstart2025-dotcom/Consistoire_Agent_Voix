/**
 * End-to-end: real API + real PostgreSQL + HOTEL MANAGER in Chromium + one SIMULATED box.
 * Run: node e2e/admin-flow.e2e.cjs   (requires `pnpm db:up`, built api/manager/simulator)
 * Screenshots → e2e/screenshots/
 */
const { spawn, execFileSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const req = (p) => require(require.resolve(p, { paths: [path.join(root, "apps/api")] }));
const { Client } = req("pg");
const { TOTP, Secret } = req("otpauth");
const { runMigrations } = require(path.join(root, "packages/db/dist/index.js"));
const { SimDevice } = require(path.join(root, "apps/device-simulator/dist/index.js"));

const DB = "hotelos_e2e";
const PG = "postgres://postgres@127.0.0.1:54329";
const SHOTS = path.join(__dirname, "screenshots");
const procs = [];
let page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).status < 500) return; } catch {}
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const c = new Client({ connectionString: `${PG}/postgres` });
  await c.connect();
  await c.query(`drop database if exists ${DB} with (force)`);
  await c.query(`create database ${DB} owner hotelos_owner`);
  await c.end();
  await runMigrations({ connectionString: `postgres://hotelos_owner:hotelos_owner@127.0.0.1:54329/${DB}` });
  const env = { ...process.env, NODE_ENV: "development", PORT: "3001", DATABASE_URL: `postgres://hotelos_api:hotelos_api@127.0.0.1:54329/${DB}`, JWT_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123", CORS_ORIGINS: "http://localhost:3000", PUBLIC_WS_URL: "ws://localhost:3001/device/v1/ws" };
  execFileSync("node", ["apps/api/dist/scripts/create-platform-admin.js"], { cwd: root, env: { ...env, ADMIN_EMAIL: "admin@hotel-os.test", ADMIN_PASSWORD: "e2e-admin-password" }, stdio: "inherit" });
  procs.push(spawn("node", ["apps/api/dist/main.js"], { cwd: root, env, stdio: "inherit", detached: true }));
  procs.push(spawn("npx", ["next", "start", "-p", "3000"], { cwd: path.join(root, "apps/manager"), env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: "ignore", detached: true }));
  await waitHttp("http://localhost:3001/health");
  await waitHttp("http://localhost:3000/login");

  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 300)); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });
  const step = (s) => console.log(`▶ ${s}`);

  step("login + mandatory TOTP enrolment");
  await page.goto("http://localhost:3000/login");
  await page.fill("#email", "admin@hotel-os.test");
  await page.fill("#password", "e2e-admin-password");
  await page.click("button[type=submit]");
  await page.waitForSelector("img[alt='QR code TOTP']");
  await shot("01-totp-enrolment");
  const secret = (await page.textContent(".mono")).replace("Clé :", "").trim();
  await page.fill("#totp", new TOTP({ secret: Secret.fromBase32(secret) }).generate());
  await page.click("button[type=submit]");
  await page.waitForURL("**/hotels");

  step("create organization and hotel");
  await page.goto("http://localhost:3000/organizations");
  await page.getByLabel("Nom").first().fill("Groupe Démo");
  await page.getByText("Créer").click();
  await page.waitForSelector("text=Groupe Démo");
  await page.goto("http://localhost:3000/hotels");
  await page.getByLabel("Nom de l'hôtel").fill("Hôtel Démo Paris");
  await page.getByText("Créer").click();
  await page.getByText("Hôtel Démo Paris").click();
  await page.waitForSelector("h1:has-text('Hôtel Démo Paris')");

  step("import rooms by CSV");
  await page.getByLabel("CSV").fill("number,floor,type,groups\n101,1,standard,Étage 1\n102,1,standard,Étage 1\n201,2,suite,Étage 2|Suites\n");
  await page.getByText("Importer").click();
  await page.waitForSelector("td >> text=201");
  await shot("02-rooms");

  step("enrollment token → simulated box enrolls");
  await page.getByRole("tab", { name: "Enrôlement" }).click();
  await page.getByText("Générer").click();
  const pre = await page.textContent("pre");
  const token = /Jeton : (\S+)/.exec(pre)[1];
  const sim = new SimDevice("http://localhost:3001", "e2e-box");
  const enrolled = await sim.enroll(token);
  await sim.sync();
  await sim.connect();

  step(`technician pairs code ${enrolled.pairingCode} to room 201`);
  await page.goto("http://localhost:3000/tech");
  await page.waitForSelector("#room option:has-text('201')", { state: "attached" });
  await page.selectOption("#room", { label: "201" });
  await page.fill("#code", enrolled.pairingCode);
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Boîtier affecté à la chambre 201");
  await page.setViewportSize({ width: 420, height: 860 });
  await shot("03-technician-pairing");
  await page.setViewportSize({ width: 1360, height: 860 });

  step("hotel configuration: allow Netflix, suspend YouTube");
  await page.goto("http://localhost:3000/hotels");
  await page.getByText("Hôtel Démo Paris").click();
  await page.getByRole("tab", { name: "Configuration" }).click();
  await page.getByLabel("Configuration JSON").waitFor();
  await page.getByLabel("Configuration JSON").fill(JSON.stringify({ apps: { "com.netflix.ninja": { state: "ALLOWED", order: 1, cleanup: "CLEAR_DATA" }, "com.google.android.youtube.tv": { state: "SUSPENDED" } }, launcher: { welcomeMessage: { fr: "Bienvenue à Paris" } } }, null, 2));
  await page.getByText("Enregistrer").click();
  await page.waitForSelector("text=boîtier(s) recalculé(s)");
  await sleep(1500); // simulator receives policy.changed over WS, re-syncs and reports

  step("applications table shows observed state");
  await page.getByRole("tab", { name: "Applications" }).click();
  await page.waitForSelector("text=com.google.android.youtube.tv");
  await shot("04-applications");
  // Columns: Installée | Autorisée | Visible | Suspendue | Masquée | Écart
  const cells = async (pkg) => (await page.locator("tr", { hasText: pkg }).locator("td").allInnerTexts()).slice(1).map((x) => x.trim().split("\n")[0]);
  const yt = await cells("com.google.android.youtube.tv");
  const nf = await cells("com.netflix.ninja");
  const expectRow = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
  expectRow("YouTube", yt, ["1/1", "0/1", "0/1", "1/1", "0/1", "0"]);
  expectRow("Netflix", nf, ["1/1", "1/1", "1/1", "0/1", "0/1", "0"]);

  step("device page: virtual remote sends a message");
  await page.getByRole("tab", { name: "Boîtiers" }).click();
  await page.getByRole("link", { name: "201" }).click();
  await page.waitForSelector("text=Télécommande virtuelle");
  await page.getByLabel("Message").fill("Votre taxi est arrivé");
  await page.getByText("Envoyer").click();
  for (let i = 0; i < 50 && !sim.stats.messages.length; i++) await sleep(100);
  if (sim.stats.messages[0] !== "Votre taxi est arrivé") throw new Error("simulator did not receive the message");
  await sleep(5500); // device page auto-refresh shows SUCCEEDED
  await shot("05-device");

  step("APK catalog: upload a real signed APK, deploy it to the hotel, the box downloads it");
  await page.goto("http://localhost:3000/catalog");
  await page.waitForSelector("#cat option", { state: "attached" });
  await page.selectOption("#cat", { label: "Groupe Démo" });
  await page.getByLabel("Fichier APK").setInputFiles(path.join(root, "apps/api/test/fixtures/fixture-v91.apk"));
  await page.getByText("Je certifie").click();
  await page.getByRole("button", { name: "Importer" }).click();
  await page.waitForSelector("text=analysée et stockée");
  await page.getByRole("button", { name: "Déployer" }).click();
  await page.waitForSelector("#scope option:has-text('Hôtel · Hôtel Démo Paris')", { state: "attached" });
  await page.selectOption("#scope", { label: "Hôtel · Hôtel Démo Paris" });
  await page.fill("#rings", "100");
  await page.getByText("Lancer le déploiement").click();
  await page.waitForURL("**/rollouts/**");
  for (let i = 0; i < 50 && !sim.installed.has("io.appium.settings"); i++) await sleep(100);
  if (sim.installed.get("io.appium.settings") !== 91) { await shot("07-rollout-debug"); throw new Error(`simulated box did not download the deployed APK: ${JSON.stringify({ stats: sim.stats, errs: sim.installErrors, policyApps: sim.policy?.apps.map((a) => [a.packageName, a.state, a.artifact?.url]) })}`); }
  await page.waitForSelector("text=· COMPLETED", { timeout: 15000 });
  await shot("07-rollout");

  step("check-out → cleanup report");
  await page.goto("http://localhost:3000/hotels");
  await page.getByText("Hôtel Démo Paris").click();
  const row = page.locator("tr", { hasText: "201" }).first();
  await row.getByText("Check-in").click();
  await page.waitForSelector("text=Check-in chambre 201");
  await row.getByText("Check-out").click();
  await page.waitForSelector("text=nettoyage envoyé");
  await shot("06-checkout");

  sim.close();
  await browser.close();
  console.log("E2E OK – screenshots in e2e/screenshots");
}

main()
  .then(() => { procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} }); process.exit(0); })
  .catch(async (e) => {
    console.error("E2E FAILED:", e);
    if (page) await page.screenshot({ path: path.join(SHOTS, "FAILURE.png"), fullPage: true }).catch(() => {});
    procs.forEach((p) => { try { process.kill(-p.pid, "SIGTERM"); } catch {} });
    process.exit(1);
  });

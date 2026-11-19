/**
 * SIMULATED HOTEL OS box. Speaks the real device protocol against the real API, for load tests,
 * protocol regression and demos. It is NOT a validation of Android behaviour: it identifies itself
 * as manufacturer "HOTEL OS Simulator" so it is visibly flagged everywhere in HOTEL MANAGER.
 */
import { type DeviceCommand, EffectivePolicy, type SignedPolicy, WsServerMessage } from "@hotel-os/protocol";
import { SignJWT } from "jose";
import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import WebSocket from "ws";

export interface SimStats {
  commands: number;
  policies: number;
  errors: number;
  lastCommandAt?: number;
  messages: string[];
}

const SIM_PACKAGES = [
  { packageName: "com.netflix.ninja", label: "Netflix", system: true },
  { packageName: "com.google.android.youtube.tv", label: "YouTube", system: true },
  { packageName: "com.amazon.amazonvideo.livingroom", label: "Prime Video", system: false },
  { packageName: "com.spotify.tv.android", label: "Spotify", system: false },
  { packageName: "com.android.tv.settings", label: "Settings", system: true },
  { packageName: "com.hotelos.launcher", label: "HOTEL OS", system: false },
];

export class SimDevice {
  private readonly key: KeyObject;
  private readonly spki: string;
  deviceId?: string;
  pairingCode?: string;
  private policyKeys: { kid: string; spki: string }[] = [];
  private policy?: EffectivePolicy;
  private ws?: WebSocket;
  private state = new Map(SIM_PACKAGES.map((p) => [p.packageName, { suspended: false, hidden: false }]));
  readonly stats: SimStats = { commands: 0, policies: 0, errors: 0, messages: [] };

  constructor(private readonly baseUrl: string, private readonly name: string) {
    const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.key = kp.privateKey;
    this.spki = kp.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  }

  private async token() {
    return new SignJWT({}).setProtectedHeader({ alg: "ES256" }).setSubject(this.deviceId!).setIssuer(this.deviceId!).setAudience("hotel-os").setIssuedAt().setExpirationTime("300s").sign(this.key);
  }

  private async call(path: string, init: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers ?? {}) };
    if (init.auth !== false) headers.authorization = `Bearer ${await this.token()}`;
    const res = await fetch(this.baseUrl + path, { method: init.method ?? (init.body ? "POST" : "GET"), headers, body: init.body ? JSON.stringify(init.body) : undefined });
    if (res.status >= 400) {
      this.stats.errors++;
      throw new Error(`${path} → HTTP ${res.status} ${await res.text()}`);
    }
    return res;
  }

  async enroll(enrollmentToken: string) {
    const res = await this.call("/device/v1/enroll", {
      auth: false,
      body: {
        enrollmentToken,
        publicKey: this.spki,
        hardware: { manufacturer: "HOTEL OS Simulator", model: "SimBox", buildFingerprint: `simulator/${this.name}`, sdkInt: 34, androidRelease: "14", supportedAbis: ["x86_64"] },
        dpcVersionCode: 1,
        isDeviceOwner: true,
      },
    });
    const body = (await res.json()) as { deviceId: string; pairingCode: string; policyPublicKeys: { kid: string; spki: string }[] };
    this.deviceId = body.deviceId;
    this.pairingCode = body.pairingCode;
    this.policyKeys = body.policyPublicKeys;
    return body;
  }

  /** Fetch, verify signature exactly like the DPC, "apply" to the simulated inventory, report. */
  async sync() {
    const res = await this.call("/device/v1/policy", { headers: this.policy ? { "if-none-match": `"${this.policy.version}"` } : {} });
    if (res.status === 200) {
      const signed = (await res.json()) as SignedPolicy;
      const key = this.policyKeys.find((k) => k.kid === signed.kid);
      const pub = key && createPublicKey({ key: Buffer.from(key.spki, "base64"), format: "der", type: "spki" });
      if (!pub || !verify("sha256", Buffer.from(signed.payload, "base64"), { key: pub, dsaEncoding: "der" }, Buffer.from(signed.signature, "base64"))) {
        this.stats.errors++;
        throw new Error("policy signature invalid");
      }
      this.policy = EffectivePolicy.parse(JSON.parse(Buffer.from(signed.payload, "base64").toString()));
      this.stats.policies++;
      // Mirrors the DPC rules (listed apps + deny-by-default for unlisted launchable apps).
      const listed = new Map(this.policy.apps.map((a) => [a.packageName, a.state]));
      const exempt = new Set([this.policy.kiosk.launcherPackage, ...this.policy.kiosk.lockTaskExtraPackages]);
      for (const [pkg, s] of this.state) {
        const st = listed.get(pkg);
        if (st) {
          s.suspended = st === "SUSPENDED";
          s.hidden = st === "HIDDEN";
        } else if (this.policy.kiosk.systemPackagesToBlock.includes(pkg)) {
          s.hidden = true;
        } else if (!exempt.has(pkg) && this.policy.kiosk.unlistedLaunchableApps === "SUSPENDED") {
          s.suspended = true;
        }
      }
    }
    await this.report();
  }

  async report() {
    if (!this.policy) return;
    await this.call("/device/v1/state", {
      body: {
        policyVersionApplied: this.policy.version,
        reconcileErrors: [{ key: "simulator", message: "SIMULATED DEVICE – no real Android enforcement" }],
        isDeviceOwner: true,
        kioskActive: true,
        launcherHealthy: true,
        dpcVersionCode: 1,
        launcherVersionCode: 1,
        apps: SIM_PACKAGES.map((p) => ({ ...p, versionCode: 1, enabled: true, ...this.state.get(p.packageName)!, hasLauncherEntry: true })),
        inventoryIsDelta: false,
        storageFreeMb: 4096,
        ramFreeMb: 900,
        network: { type: "ETHERNET", ip: "10.0.0.42" },
        buildFingerprint: `simulator/${this.name}`,
      },
    });
  }

  connect(): Promise<void> {
    return new Promise(async (resolve, reject) => {
      this.ws = new WebSocket(this.baseUrl.replace(/^http/, "ws") + "/device/v1/ws", { headers: { authorization: `Bearer ${await this.token()}` } });
      this.ws.on("open", () => {
        this.ws!.send(JSON.stringify({ t: "hello", policyVersion: this.policy?.version ?? 0, protocol: 1 }));
        resolve();
      });
      this.ws.on("error", (e) => { this.stats.errors++; reject(e); });
      this.ws.on("message", (d) => void this.onFrame(d.toString()).catch(() => this.stats.errors++));
    });
  }

  private async onFrame(raw: string) {
    const m = WsServerMessage.parse(JSON.parse(raw));
    if (m.t === "policy.changed" || (m.t === "welcome" && m.latestPolicyVersion !== this.policy?.version)) await this.sync();
    if (m.t === "command") await this.execute(m.command);
  }

  private async execute(c: DeviceCommand) {
    this.stats.commands++;
    this.stats.lastCommandAt = Date.now();
    const update = (status: string, message?: string) => this.ws?.send(JSON.stringify({ t: "command.update", commandId: c.id, result: { status, message } }));
    update("ACKED");
    if (c.type === "SHOW_MESSAGE") this.stats.messages.push(String(c.payload.text));
    if (c.type === "SYNC_NOW") await this.sync();
    if (c.type === "CHECKOUT_CLEANUP") {
      const apps = (c.payload.apps as { packageName: string; action: string }[]) ?? [];
      await this.call(`/device/v1/cleanup/${c.payload.cleanupJobId}/report`, {
        body: { outcome: "SUCCEEDED", apps: apps.map((a) => ({ ...a, ok: true, message: "SIMULATED" })), finishedAt: new Date().toISOString() },
      });
      return;
    }
    update("SUCCEEDED", "SIMULATED – executed by device simulator");
  }

  heartbeat() {
    this.ws?.send(JSON.stringify({ t: "heartbeat" }));
  }

  close() {
    this.ws?.close();
  }
}

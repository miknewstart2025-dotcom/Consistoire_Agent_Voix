import { Injectable, Logger } from "@nestjs/common";
import { PROTOCOL_VERSION, WsClientMessage } from "@hotel-os/protocol";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { CommandsService, toWire } from "../commands/commands.service";
import { DeviceAuthService } from "../devices/device-auth.service";
import { DevicesService } from "../devices/devices.service";
import { PolicyService } from "../policy/policy.service";
import { DeviceConnections } from "./device-connections";

export const WS_PATH = "/device/v1/ws";
const MAX_FRAME = 64 * 1024;

/**
 * Device WebSocket. Auth = same device JWT as REST, in the Authorization header of the upgrade request.
 * Frames are validated with the shared protocol schemas; anything invalid is answered with an error frame.
 */
@Injectable()
export class DeviceGateway {
  private readonly log = new Logger(DeviceGateway.name);
  private wss?: WebSocketServer;

  constructor(
    private readonly auth: DeviceAuthService,
    private readonly conns: DeviceConnections,
    private readonly commands: CommandsService,
    private readonly policy: PolicyService,
    private readonly devices: DevicesService,
  ) {}

  attach(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      if (!req.url?.startsWith(WS_PATH)) return; // other upgrade handlers may exist
      const h = req.headers.authorization;
      if (!h?.startsWith("Bearer ")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.auth
        .authenticate(h.slice(7))
        .then((dev) => this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, dev.deviceId)))
        .catch(() => {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
        });
    });
  }

  close() {
    this.conns.closeAll();
    this.wss?.close();
  }

  private async onConnection(ws: WebSocket, deviceId: string) {
    this.conns.register(deviceId, ws);
    ws.on("close", () => this.conns.unregister(deviceId, ws));
    ws.on("error", (e) => this.log.warn(`ws ${deviceId}: ${e.message}`));
    ws.on("message", (data) => void this.onMessage(ws, deviceId, data.toString()).catch((e) => this.log.error(`ws ${deviceId}: ${(e as Error).message}`)));
    await this.devices.touch(deviceId);
    const latest = await this.policy.latestSigned(deviceId);
    ws.send(JSON.stringify({ t: "welcome", serverTime: new Date().toISOString(), latestPolicyVersion: latest?.version ?? 0 }));
  }

  private async onMessage(ws: WebSocket, deviceId: string, raw: string) {
    let msg: WsClientMessage;
    try {
      msg = WsClientMessage.parse(JSON.parse(raw));
    } catch {
      ws.send(JSON.stringify({ t: "error", code: "BAD_FRAME", message: "invalid message" }));
      return;
    }
    switch (msg.t) {
      case "hello": {
        if (msg.protocol !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ t: "error", code: "PROTOCOL_MISMATCH", message: `server speaks protocol ${PROTOCOL_VERSION}` }));
        }
        const latest = await this.policy.latestSigned(deviceId);
        if (latest && latest.version !== msg.policyVersion) ws.send(JSON.stringify({ t: "policy.changed", version: latest.version }));
        for (const c of await this.commands.pendingFor(deviceId)) {
          ws.send(JSON.stringify({ t: "command", command: toWire(c) }));
          if (c.status === "QUEUED") await this.commands.markDelivered(deviceId, [c.id]);
        }
        break;
      }
      case "heartbeat":
        await this.devices.touch(deviceId);
        break;
      case "command.update":
        await this.commands.transition(deviceId, msg.commandId, msg.result, "device").catch((e) => {
          ws.send(JSON.stringify({ t: "error", code: "COMMAND_UPDATE_REJECTED", message: (e as Error).message }));
        });
        break;
    }
  }
}

import { Injectable, Logger } from "@nestjs/common";
import type { WsServerMessage } from "@hotel-os/protocol";
import type { WebSocket } from "ws";

/**
 * In-process registry of connected devices.
 * LIMITATION (documented in docs/PROGRESS.md): single API instance. Multi-instance fan-out
 * via Redis pub/sub is a Phase 7 item; until then commands/policies are still delivered
 * by the devices' periodic REST polling.
 */
@Injectable()
export class DeviceConnections {
  private readonly log = new Logger(DeviceConnections.name);
  private readonly sockets = new Map<string, WebSocket>();

  register(deviceId: string, ws: WebSocket) {
    const prev = this.sockets.get(deviceId);
    if (prev && prev !== ws) prev.close(4000, "replaced by a newer connection");
    this.sockets.set(deviceId, ws);
  }
  unregister(deviceId: string, ws: WebSocket) {
    if (this.sockets.get(deviceId) === ws) this.sockets.delete(deviceId);
  }
  isOnline(deviceId: string) {
    return this.sockets.get(deviceId)?.readyState === 1;
  }
  onlineCount() {
    return this.sockets.size;
  }
  /** Returns true when the frame was handed to an open socket. */
  send(deviceId: string, msg: WsServerMessage): boolean {
    const ws = this.sockets.get(deviceId);
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.log.warn(`send to ${deviceId} failed: ${(e as Error).message}`);
      return false;
    }
  }
  closeAll() {
    for (const ws of this.sockets.values()) ws.close(1001, "server shutdown");
    this.sockets.clear();
  }
}

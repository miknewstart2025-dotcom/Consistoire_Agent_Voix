import { Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import { CommandResult, DeviceStateReport, EnrollRequest } from "@hotel-os/protocol";
import type { Response } from "express";
import { parse, uuidParam } from "../common/validation";
import { CommandsService, toWire } from "../commands/commands.service";
import { PolicyService } from "../policy/policy.service";
import type { DevicePrincipal } from "./device-auth.service";
import { CurrentDevice, DeviceGuard } from "./device.guard";
import { DevicesService } from "./devices.service";

/** API used by HOTEL DEVICE CONTROLLER. Documented in docs/PROTOCOL.md. */
@Controller("device/v1")
export class DeviceApiController {
  constructor(
    private readonly devices: DevicesService,
    private readonly policy: PolicyService,
    private readonly commands: CommandsService,
  ) {}

  @Post("enroll")
  @HttpCode(201)
  enroll(@Body() body: unknown, @Req() req: { ip?: string }) {
    return this.devices.enroll(parse(EnrollRequest, body), req.ip);
  }

  @Post("pairing-code")
  @UseGuards(DeviceGuard)
  @HttpCode(200)
  pairingCode(@CurrentDevice() d: DevicePrincipal) {
    return this.devices.renewPairingCode(d);
  }

  /** Signed policy. Supports If-None-Match with the version number (304 when unchanged). */
  @Get("policy")
  @UseGuards(DeviceGuard)
  async getPolicy(@CurrentDevice() d: DevicePrincipal, @Headers("if-none-match") inm: string | undefined, @Res() res: Response) {
    const signed = await this.policy.latestSigned(d.deviceId);
    if (!signed) throw new NotFoundException({ code: "NO_POLICY_YET" });
    const etag = `"${signed.version}"`;
    res.setHeader("ETag", etag);
    if (inm === etag) return res.status(304).end();
    return res.status(200).json(signed);
  }

  @Post("state")
  @UseGuards(DeviceGuard)
  @HttpCode(204)
  async state(@CurrentDevice() d: DevicePrincipal, @Body() body: unknown) {
    const report = parse(DeviceStateReport, body);
    await this.devices.reportState(d, report);
    await this.devices.touchAfterState(d, report);
  }

  /** Polling fallback when the WebSocket is down. Returned commands are marked DELIVERED. */
  @Get("commands")
  @UseGuards(DeviceGuard)
  async pending(@CurrentDevice() d: DevicePrincipal) {
    await this.devices.touch(d.deviceId);
    const rows = await this.commands.pendingFor(d.deviceId);
    await this.commands.markDelivered(d.deviceId, rows.filter((r) => r.status === "QUEUED").map((r) => r.id));
    return rows.map(toWire);
  }

  @Post("commands/:id/result")
  @UseGuards(DeviceGuard)
  @HttpCode(200)
  async result(@CurrentDevice() d: DevicePrincipal, @Param("id") id: string, @Body() body: unknown) {
    const updated = await this.commands.transition(d.deviceId, uuidParam(id), parse(CommandResult, body), "device");
    return { applied: updated !== null };
  }
}

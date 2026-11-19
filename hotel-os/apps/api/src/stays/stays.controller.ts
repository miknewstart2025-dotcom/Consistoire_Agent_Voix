import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { CleanupReport, Language } from "@hotel-os/protocol";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { parse, uuidParam } from "../common/validation";
import type { DevicePrincipal } from "../devices/device-auth.service";
import { CurrentDevice, DeviceGuard } from "../devices/device.guard";
import { StaysService } from "./stays.service";

const CheckIn = z.object({
  guestFirstName: z.string().min(1).max(60).optional(),
  /** Name is only stored and displayed with explicit consent. */
  displayNameConsent: z.boolean().default(false),
  language: Language.optional(),
  pmsRef: z.string().max(100).optional(),
});

@Controller()
export class StaysController {
  constructor(
    private readonly access: AccessService,
    private readonly stays: StaysService,
  ) {}

  @Post("v1/rooms/:id/check-in")
  @UseGuards(AdminGuard)
  async checkIn(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const r = await this.access.requireRoom(p, "stay:write", uuidParam(id));
    return this.stays.checkIn(r.ctx, r, parse(CheckIn, body ?? {}), p.userId);
  }

  @Post("v1/rooms/:id/check-out")
  @UseGuards(AdminGuard)
  @HttpCode(200)
  async checkOut(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const r = await this.access.requireRoom(p, "stay:write", uuidParam(id));
    return this.stays.checkOut(r.ctx, r, p.userId);
  }

  @Get("v1/rooms/:id/stays")
  @UseGuards(AdminGuard)
  async list(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const r = await this.access.requireRoom(p, "stay:read", uuidParam(id));
    return this.stays.listForRoom(r.ctx, r.id);
  }

  @Post("device/v1/cleanup/:jobId/report")
  @UseGuards(DeviceGuard)
  @HttpCode(200)
  report(@CurrentDevice() d: DevicePrincipal, @Param("jobId") jobId: string, @Body() body: unknown) {
    return this.stays.report(d, uuidParam(jobId), parse(CleanupReport, body));
  }
}

import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { parse } from "../common/validation";
import { AdminGuard } from "./admin.guard";
import { AuthService } from "./auth.service";
import { CurrentPrincipal, type Principal } from "./principal";

const Login = z.object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().max(10).optional() });
const Setup = z.object({ setupToken: z.string() });
const Confirm = z.object({ setupToken: z.string(), code: z.string().min(6).max(10) });

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: { ip?: string }) {
    const b = parse(Login, body);
    return this.auth.login(b.email, b.password, b.totp, req.ip);
  }

  @Post("totp/setup")
  @HttpCode(200)
  setup(@Body() body: unknown) {
    return this.auth.beginTotpSetup(parse(Setup, body).setupToken);
  }

  @Post("totp/confirm")
  @HttpCode(200)
  confirm(@Body() body: unknown, @Req() req: { ip?: string }) {
    const b = parse(Confirm, body);
    return this.auth.confirmTotpSetup(b.setupToken, b.code, req.ip);
  }

  @Get("me")
  @UseGuards(AdminGuard)
  me(@CurrentPrincipal() p: Principal) {
    return p;
  }
}

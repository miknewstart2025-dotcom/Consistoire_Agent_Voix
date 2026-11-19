import { Global, Module } from "@nestjs/common";
import { AccessService } from "./access.service";
import { AdminGuard } from "./admin.guard";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";

@Global()
@Module({ controllers: [AuthController], providers: [AuthService, AdminGuard, AccessService], exports: [AuthService, AdminGuard, AccessService] })
export class AuthModule {}

import { AppDesiredState, CleanupPolicy, KioskMode, Language, UserRestriction } from "@hotel-os/protocol";
import { z } from "zod";
import type { PolicyConfig } from "./config";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const pkg = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/, "invalid Android package name");

/** Validates a config layer as edited by admins. Strict: unknown keys are rejected. */
export const PolicyConfigSchema: z.ZodType<PolicyConfig> = z
  .object({
    kiosk: z
      .object({
        mode: KioskMode.optional(),
        launcherPackage: pkg.optional(),
        lockTaskExtraPackages: z.array(pkg).optional(),
        systemPackagesToBlock: z.array(pkg).optional(),
        unlistedLaunchableApps: z.enum(["SUSPENDED", "UNMANAGED"]).optional(),
      })
      .strict()
      .optional(),
    restrictions: z.record(UserRestriction, z.boolean()).optional(),
    apps: z
      .record(
        pkg,
        z
          .object({
            state: AppDesiredState.optional(),
            visibleInLauncher: z.boolean().optional(),
            order: z.number().int().min(0).max(10000).optional(),
            label: z.string().max(80).optional(),
            cleanup: CleanupPolicy.optional(),
          })
          .strict(),
      )
      .optional(),
    launcher: z
      .object({
        template: z.string().max(40).optional(),
        language: Language.optional(),
        availableLanguages: z.array(Language).min(1).optional(),
        branding: z
          .object({
            hotelName: z.string().max(120).optional(),
            logoUrl: z.string().url().optional(),
            backgroundUrl: z.string().url().optional(),
            primaryColor: hex.optional(),
            accentColor: hex.optional(),
          })
          .strict()
          .optional(),
        welcomeMessage: z.record(Language, z.string().max(500)).optional(),
        roomNumber: z.string().max(20).optional(),
        guestFirstName: z.string().max(60).optional(),
        modules: z.record(z.string().regex(/^[a-z_]+$/), z.boolean()).optional(),
        idleReturnHomeMinutes: z.number().int().min(0).max(10080).optional(),
      })
      .strict()
      .optional(),
    system: z
      .object({
        timezone: z.string().optional(),
        autoTime: z.boolean().optional(),
        maintenanceWindow: z.object({ start: hhmm.optional(), end: hhmm.optional() }).strict().optional(),
        telemetryIntervalSec: z.number().int().min(30).max(86400).optional(),
        screenCaptureDisabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    iptv: z.object({ enabled: z.boolean().optional(), lineupId: z.string().uuid().optional() }).strict().optional(),
    wifi: z
      .array(z.object({ ssid: z.string().min(1).max(32), security: z.enum(["OPEN", "WPA2", "WPA3"]), passphraseRef: z.string().optional() }).strict())
      .optional(),
  })
  .strict() as z.ZodType<PolicyConfig>;

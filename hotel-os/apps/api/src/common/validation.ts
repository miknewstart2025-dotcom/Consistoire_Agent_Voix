import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";

/** Parses untrusted input; throws 400 with the zod issues. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new BadRequestException({
      code: "VALIDATION_FAILED",
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(v: string, name = "id"): string {
  if (!UUID_RE.test(v)) throw new BadRequestException({ code: "INVALID_ID", message: `${name} must be a uuid` });
  return v;
}

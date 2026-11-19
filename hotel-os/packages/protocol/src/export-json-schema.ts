/* Exports JSON Schemas so the Kotlin side can be checked against the same contract. */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as P from "./index";

const out = join(__dirname, "..", "json-schema");
mkdirSync(out, { recursive: true });
const schemas = {
  EffectivePolicy: P.EffectivePolicy,
  SignedPolicy: P.SignedPolicy,
  EnrollRequest: P.EnrollRequest,
  EnrollResponse: P.EnrollResponse,
  DeviceStateReport: P.DeviceStateReport,
  DeviceCommand: P.DeviceCommand,
  CommandResult: P.CommandResult,
  CleanupReport: P.CleanupReport,
  WsClientMessage: P.WsClientMessage,
  WsServerMessage: P.WsServerMessage,
};
for (const [name, schema] of Object.entries(schemas)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(zodToJsonSchema(schema, name), null, 2));
}
console.log(`Wrote ${Object.keys(schemas).length} schemas to ${out}`);

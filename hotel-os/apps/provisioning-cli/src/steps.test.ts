import { describe, expect, it } from "vitest";
import { checkNoAccounts, checkSetDeviceOwner, plan } from "./steps";

describe("provisioning plan", () => {
  it("orders steps safely and targets the serial", () => {
    const p = plan({ serial: "ABC", dpcApk: "dpc.apk", launcherApk: "l.apk", serverUrl: "https://api", token: "t".repeat(32) });
    expect(p.map((s) => s.name)).toEqual(["device reachable", "no accounts on device", "no secondary users", "install controller", "install launcher", "set Device Owner", "configure server + enrollment token", "verify Device Owner"]);
    expect(p.every((s) => s.args[0] === "-s" && s.args[1] === "ABC")).toBe(true);
  });
  it("interprets dpm output", () => {
    expect(checkSetDeviceOwner("Success: Device owner set to package ComponentInfo{com.hotelos.dpc/...}")).toBeNull();
    expect(checkSetDeviceOwner("java.lang.IllegalStateException: Not allowed to set the device owner because there are already some accounts on the device")).toMatch(/factory reset/);
    expect(checkSetDeviceOwner("Not allowed to set the device owner because the device has already been provisioned")).toMatch(/already provisioned/);
    expect(checkSetDeviceOwner("weird")).toMatch(/INCOMPATIBLE/);
    expect(checkNoAccounts("Accounts: 1\n  Account {name=x@gmail.com}")).toMatch(/account/);
    expect(checkNoAccounts("Accounts: 0")).toBeNull();
  });
});

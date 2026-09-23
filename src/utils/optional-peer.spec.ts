import { describe, expect, it } from "vitest";
import { loadOptionalPeer } from "./optional-peer.js";

describe("loadOptionalPeer", () => {
  it("returns installed:false for a missing package", () => {
    expect(loadOptionalPeer("@crudmates/definitely-not-real")).toEqual({
      installed: false,
    });
  });

  it("loads an installed package", () => {
    const result = loadOptionalPeer<typeof import("rxjs")>("rxjs");
    expect(result.installed).toBe(true);
    if (result.installed) expect(result.module).toBeDefined();
  });

  it("probeOnly reports installed without requiring the module", () => {
    const probed = loadOptionalPeer("rxjs", "rxjs", { probeOnly: true });
    expect(probed).toEqual({ installed: true, module: undefined });
  });
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ELAN_INSTALL, lakeOnPath, leanMissingHint } from "./lean-toolchain";

describe("lakeOnPath", () => {
  // Hermetic: never depends on whether the runner actually has elan installed (CI runs the suite
  // BEFORE the elan install step), so both cases fabricate their own PATH.
  let binDir: string;

  beforeAll(() => {
    binDir = mkdtempSync(join(tmpdir(), "toffoli-fakelake-"));
    const lake = join(binDir, "lake");
    writeFileSync(lake, "#!/bin/sh\nexit 0\n");
    chmodSync(lake, 0o755);
  });

  afterAll(() => {
    rmSync(binDir, { recursive: true, force: true });
  });

  it("is false when no lake resolves on PATH", () => {
    expect(lakeOnPath({ PATH: join(tmpdir(), "toffoli-no-such-bin-dir") } as NodeJS.ProcessEnv)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("is true when a lake binary is on PATH", () => {
    expect(lakeOnPath({ PATH: binDir } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("leanMissingHint", () => {
  it("names elan, the exact install command, and scopes it to the proof gates", () => {
    const hint = leanMissingHint();
    expect(hint).toContain("elan");
    expect(hint).toContain(ELAN_INSTALL);
    expect(hint).toContain("npm run gate");
    expect(hint).toContain("npm run proof:check");
  });
});

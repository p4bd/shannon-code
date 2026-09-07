import { describe, expect, it } from "vitest";
import {
  getPermissionSubject,
  matchesPermissionRule,
} from "../../src/permissions/rules.js";

describe("permission rules", () => {
  it("matches tool and subject wildcards", () => {
    expect(matchesPermissionRule("read_file:*", "read_file", "src/a.ts")).toBe(
      true,
    );
    expect(
      matchesPermissionRule("run_shell:npm run *", "run_shell", "npm run build"),
    ).toBe(true);
    expect(
      matchesPermissionRule("run_shell:npm test", "run_shell", "npm run build"),
    ).toBe(false);
  });

  it("extracts command and path subjects", () => {
    expect(getPermissionSubject({ command: " npm   test " })).toBe("npm test");
    expect(getPermissionSubject({ path: "src\\index.ts" })).toBe(
      "src/index.ts",
    );
  });
});

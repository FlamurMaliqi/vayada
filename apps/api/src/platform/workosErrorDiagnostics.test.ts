import { describe, expect, it } from "vitest";
import { workosErrorDiagnostics } from "./workosErrorDiagnostics.js";

describe("workosErrorDiagnostics", () => {
  it.each([
    null,
    undefined,
    "secret",
    new Error("secret"),
    {
      code: "private@example.test",
      status: "401",
      requestID: "Bearer secret",
    },
  ])("omits unsafe or absent metadata", (error) => {
    expect(JSON.stringify(workosErrorDiagnostics(error))).toBe("{}");
  });
});

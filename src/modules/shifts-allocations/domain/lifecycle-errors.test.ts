import { describe, expect, it } from "vitest";
import { lifecycleDbMessage } from "./lifecycle-errors";

describe("lifecycleDbMessage", () => {
  it("shows the database's user message as is", () => {
    expect(
      lifecycleDbMessage({
        code: "55000",
        message:
          "it is too early to start this allocation: it can be started from 2026-11-18 07:00 (60 minutes before the planned start)",
        hint: "user_message",
      }),
    ).toMatch(/^it is too early/);
  });
  it("never echoes unmarked SQL text", () => {
    const m = lifecycleDbMessage({
      code: "XX000",
      message: 'relation "vehicle_allocations" blew up',
    });
    expect(m).not.toMatch(/vehicle_allocations/);
  });
  it("maps the core's window error and common codes", () => {
    expect(
      lifecycleDbMessage({
        code: "22023",
        message:
          "the planned times must lie within the shift's scheduled window",
      }),
    ).toBe("The planned times must lie within the shift.");
    expect(
      lifecycleDbMessage({ code: "PGRST301", message: "JWT expired" }),
    ).toMatch(/expired/);
    expect(
      lifecycleDbMessage({
        code: "42501",
        message: "permission denied for table x",
      }),
    ).toBe("You are not allowed to do this.");
    expect(lifecycleDbMessage({ code: "0A000", message: "x" })).toMatch(
      /not available yet/,
    );
  });
});

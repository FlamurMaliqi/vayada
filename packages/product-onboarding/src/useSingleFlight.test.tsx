import { StrictMode, useEffect } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import { useSingleFlightGuard } from "./useSingleFlight";

describe("useSingleFlightGuard", () => {
  it("starts a one-time redemption only once when an effect is replayed", () => {
    const redeem = vi.fn();

    function HandoffHarness() {
      const begin = useSingleFlightGuard();
      useEffect(() => {
        if (begin()) redeem();
        if (begin()) redeem();
      }, [begin]);
      return null;
    }

    act(() => {
      create(
        <StrictMode>
          <HandoffHarness />
        </StrictMode>,
      );
    });

    expect(redeem).toHaveBeenCalledTimes(1);
  });
});

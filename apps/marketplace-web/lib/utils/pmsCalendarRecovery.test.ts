import { describe, expect, it } from "vitest";
import { isPmsCalendarRecovery } from "./pmsCalendarRecovery";
const recovery = {
  recovery: "pms-calendar",
  entryProduct: "pms",
  returnProduct: "pms",
  propertyId: "11111111-1111-4111-8111-111111111111",
  step: "calendar",
};
describe("PMS calendar recovery entry", () => {
  it("opens canonical recovery for an explicit property independently of general onboarding", () => {
    expect(isPmsCalendarRecovery(recovery)).toBe(true);
    expect(isPmsCalendarRecovery({ ...recovery, step: "rooms" })).toBe(true);
  });
  it.each([
    {},
    { ...recovery, recovery: undefined },
    { ...recovery, entryProduct: "marketplace" },
    { ...recovery, returnProduct: "booking" },
    { ...recovery, propertyId: "" },
    { ...recovery, propertyId: [recovery.propertyId] },
  ])("keeps other entries on their configured rollout", (params) => {
    expect(isPmsCalendarRecovery(params)).toBe(false);
  });
});

"use client";

import type { SharedSetupTaskFormContext } from "@vayada/product-onboarding";

import { MarketplaceSetupTaskForm } from "./MarketplaceSetupTaskForm";
import { DirectBookingPublicationForm } from "./operations/DirectBookingPublicationForm";
import { BillingPlanSetupForm } from "./operations/BillingPlanSetupForm";
import { GuestSettingsPoliciesForm } from "./operations/GuestSettingsPoliciesForm";
import { PaymentSetupForm } from "./operations/PaymentSetupForm";
import { RoomsRatesAvailabilityForm } from "./operations/RoomsRatesAvailabilityForm";

export function SetupTaskFormRouter({
  task,
  propertyId,
  onBeforeSave,
  onComplete,
  onBack,
  onDirty,
}: SharedSetupTaskFormContext) {
  if (task.taskId === "public_profile" || task.taskId === "creator_offer") {
    return (
      <MarketplaceSetupTaskForm
        key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
        taskId={task.taskId}
        propertyId={propertyId}
        onBeforeSave={onBeforeSave}
        onCompleted={onComplete}
        onBack={onBack}
        onDirty={onDirty}
      />
    );
  }

  if (
    task.taskId === "rooms_rates_availability" ||
    task.taskId === "guest_settings_policies" ||
    task.taskId === "billing_plan" ||
    task.taskId === "payment" ||
    task.taskId === "direct_booking_publication"
  ) {
    const props = { onBack, onBeforeSave, onCompleted: onComplete, propertyId };
    switch (task.taskId) {
      case "rooms_rates_availability":
        return (
          <RoomsRatesAvailabilityForm
            {...props}
            key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
            taskComplete={task.readiness === "complete"}
          />
        );
      case "guest_settings_policies":
        return (
          <GuestSettingsPoliciesForm
            {...props}
            key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
            taskComplete={task.readiness === "complete"}
          />
        );
      case "billing_plan":
        return (
          <BillingPlanSetupForm
            {...props}
            key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
            taskComplete={task.readiness === "complete"}
          />
        );
      case "payment":
        return (
          <PaymentSetupForm
            {...props}
            key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
          />
        );
      case "direct_booking_publication":
        return (
          <DirectBookingPublicationForm
            {...props}
            key={`${propertyId}:${task.taskId}:${task.sourceRevision}`}
          />
        );
    }
  }

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
      This setup step is managed by the shared hotel details form.
    </div>
  );
}

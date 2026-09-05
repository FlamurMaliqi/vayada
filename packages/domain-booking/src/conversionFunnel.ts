export const FUNNEL_STAGES = [
  "page_visit",
  "room_viewed",
  "rate_selected",
  "addons_step_passed",
  "details_completed",
  "complete_booking_clicked",
  "payment_authorized",
  "booking_completed",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];
export const FUNNEL_PAYMENT_METHODS = [
  "card",
  "bank_transfer",
  "pay_at_property",
  "xendit",
  "paypal",
] as const;
export type FunnelPaymentMethod = (typeof FUNNEL_PAYMENT_METHODS)[number];
export type BookingFunnelEvent = {
  sessionId: string;
  sequence: number;
  stage: FunnelStage;
  paymentMethod?: FunnelPaymentMethod;
};
export type BookingConversionFunnel = {
  steps: {
    stage: FunnelStage;
    count: number;
    percentOfVisits: number | null;
    conversionPercent: number | null;
    previousCount: number;
  }[];
  paymentMethods: { method: FunnelPaymentMethod; count: number }[];
  biggestDrop: FunnelStage | null;
};
export type BookingConversionFunnelReadPort = {
  getConversionFunnel(input: {
    propertyId: string;
    windowStart: string;
    windowEnd: string;
  }): Promise<BookingConversionFunnel | null>;
};

/** Events are already property/time/traffic scoped by the target repository. */
export function buildBookingConversionFunnel(
  events: readonly BookingFunnelEvent[],
  addonsEnabled: boolean,
): BookingConversionFunnel {
  const stages = FUNNEL_STAGES.filter((stage) => addonsEnabled || stage !== "addons_step_passed");
  const prefix = stages.slice(0, stages.indexOf("complete_booking_clicked"));
  const sessions = new Map<
    string,
    {
      next: number;
      method?: FunnelPaymentMethod;
      authorized: boolean;
      completed: boolean;
      sequence: number;
    }
  >();
  const counts = new Map<FunnelStage, number>(stages.map((stage) => [stage, 0]));
  const methods = new Map<FunnelPaymentMethod, number>(
    FUNNEL_PAYMENT_METHODS.map((method) => [method, 0]),
  );
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (!event.sessionId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) continue;
    let session = sessions.get(event.sessionId);
    if (!session) {
      session = { next: 0, authorized: false, completed: false, sequence: 0 };
      sessions.set(event.sessionId, session);
    }
    if (event.sequence <= session.sequence) continue;
    session.sequence = event.sequence;
    if (session.next < prefix.length) {
      if (event.stage !== prefix[session.next]) continue;
      counts.set(event.stage, (counts.get(event.stage) ?? 0) + 1);
      session.next++;
      continue;
    }
    if (session.completed) continue;
    if (
      event.stage === "complete_booking_clicked" &&
      event.paymentMethod &&
      FUNNEL_PAYMENT_METHODS.includes(event.paymentMethod)
    ) {
      if (session.method === event.paymentMethod) continue;
      if (session.method) {
        methods.set(session.method, methods.get(session.method)! - 1);
        if (session.authorized)
          counts.set("payment_authorized", counts.get("payment_authorized")! - 1);
      } else counts.set(event.stage, counts.get(event.stage)! + 1);
      session.method = event.paymentMethod;
      session.authorized = false;
      methods.set(session.method, methods.get(session.method)! + 1);
    } else if (event.paymentMethod === session.method && session.method) {
      if (
        event.stage === "payment_authorized" &&
        session.method === "card" &&
        !session.authorized
      ) {
        session.authorized = true;
        counts.set(event.stage, counts.get(event.stage)! + 1);
      } else if (
        event.stage === "booking_completed" &&
        (session.method !== "card" || session.authorized)
      ) {
        session.completed = true;
        counts.set(event.stage, counts.get(event.stage)! + 1);
      }
    }
  }
  const visits = counts.get("page_visit")!;
  const percent = (count: number, total: number) =>
    total ? Math.round((count / total) * 1000) / 10 : null;
  let biggestDrop: FunnelStage | null = null;
  let largestLoss = 0;
  const steps = stages.map((stage, index) => {
    const count = counts.get(stage)!;
    const previousCount =
      stage === "payment_authorized"
        ? methods.get("card")!
        : stage === "booking_completed"
          ? counts.get("payment_authorized")! +
            counts.get("complete_booking_clicked")! -
            methods.get("card")!
          : counts.get(stages[Math.max(0, index - 1)]!)!;
    const loss = previousCount ? 1 - count / previousCount : 0;
    if (index > 0 && loss > largestLoss) {
      largestLoss = loss;
      biggestDrop = stage;
    }
    return {
      stage,
      count,
      percentOfVisits: percent(count, visits),
      conversionPercent: percent(count, previousCount),
      previousCount,
    };
  });
  return {
    steps,
    paymentMethods: [...methods]
      .filter(([, count]) => count > 0)
      .map(([method, count]) => ({ method, count })),
    biggestDrop,
  };
}

import {
  addPmsBlocker,
  ownerStatusForHotel,
  pmsMediaForSource,
  propertyForHotel,
  safePmsSourceId,
} from "./productionPmsContext.js";
import type { IdentitySourceRow } from "./productionIdentityDisposition.js";
import type { PmsBuildContext, PmsRoomBuild, PmsTargetRecord } from "./productionPmsTypes.js";
import {
  bool,
  currency,
  date,
  deterministicUuid,
  integer,
  iso,
  money,
  optionalText,
  requiredText,
  sha256,
  uuid,
} from "./productionBookingValues.js";
import {
  horizon,
  jsonArray,
  jsonMap,
  percentage,
  pmsRecord,
  recurringDateRanges,
  signedDecimal,
} from "./productionPmsValues.js";

export function buildPmsRoomRecords(context: PmsBuildContext): PmsRoomBuild {
  const records: PmsTargetRecord[] = [];
  const flexiblePlanByRoomType = new Map<string, string>();
  const channelPlanByMapping = new Map<string, string>();
  const duplicateNameDispositions = roomTypeDuplicateNameDispositions(context);
  const currencyDispositions = roomTypeCurrencyDispositions(context);
  for (const source of context.rowsByTable.get("linked_inventory_groups") ?? [])
    append(context, source, records, () => linkedGroup(context, source));
  for (const source of context.rowsByTable.get("room_types") ?? [])
    append(context, source, records, () => {
      const built = roomType(
        context,
        source,
        duplicateNameDispositions.get(uuid(source.data["id"], "id")),
        currencyDispositions.get(uuid(source.data["id"], "id")),
      );
      flexiblePlanByRoomType.set(built.roomTypeId, built.flexiblePlanId);
      return built.records;
    });
  for (const source of context.rowsByTable.get("rooms") ?? [])
    append(context, source, records, () => room(context, source));
  for (const source of context.rowsByTable.get("channex_rate_plan_mappings") ?? [])
    append(context, source, records, () => {
      const built = channelPlan(context, source);
      channelPlanByMapping.set(built.mappingId, built.planId);
      return [built.record];
    });
  return { records, flexiblePlanByRoomType, channelPlanByMapping };
}

type RoomTypeDuplicateNameDisposition = {
  canonicalRoomTypeId: string | null;
  duplicateGroupSize: number;
  effectiveActive: boolean;
  reasonCode:
    | "duplicate_name_canonical"
    | "duplicate_name_empty_inactive"
    | "duplicate_name_historical_inactive";
  sourceActive: boolean;
};

type RoomTypeCurrencyDisposition = {
  currencyEligibleActive: boolean;
  groupCurrencies: string[];
  reasonCode:
    | "ambiguous_currency_group_inactive"
    | "conflicting_currency_historical_inactive"
    | "historical_currency_inactive"
    | "live_currency_retained"
    | "sole_active_currency_retained";
  retainedCurrency: string | null;
  sourceActive: boolean;
  sourceCurrency: string;
};

function roomTypeDuplicateNameDispositions(
  context: PmsBuildContext,
): Map<string, RoomTypeDuplicateNameDisposition> {
  const groups = new Map<string, Array<{ id: string; row: IdentitySourceRow }>>();
  for (const row of context.rowsByTable.get("room_types") ?? []) {
    try {
      if (!bool(row.data["is_active"], "is_active", true)) continue;
      const id = uuid(row.data["id"], "id");
      const propertyId = context.propertyByHotel.get(
        requiredText(row.data["hotel_id"], "hotel_id").toLowerCase(),
      );
      if (!propertyId) continue;
      const name = requiredText(row.data["name"], "name").trim().toLowerCase();
      const key = `${propertyId}:${name}`;
      groups.set(key, [...(groups.get(key) ?? []), { id, row }]);
    } catch {
      // The normal row builder records malformed source fields as blockers.
    }
  }

  const result = new Map<string, RoomTypeDuplicateNameDisposition>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const evidence = group.map((entry) => duplicateRoomTypeEvidence(context, entry));
    const live = evidence.filter((entry) => entry.live);
    if (live.length > 1) {
      for (const entry of live)
        addPmsBlocker(
          context,
          "DUPLICATE_ACTIVE_ROOM_TYPE_NAME",
          "pms.room_types",
          entry.id,
          "Multiple same-name room types retain future or channel evidence",
        );
      continue;
    }
    const canonical =
      live[0] ??
      evidence.filter((entry) => entry.capacity > 0).sort(compareDuplicateRoomTypeEvidence)[0] ??
      null;
    for (const entry of evidence) {
      const effectiveActive = canonical?.id === entry.id;
      context.effectiveRoomTypeActiveById.set(entry.id, effectiveActive);
      result.set(entry.id, {
        canonicalRoomTypeId: canonical?.id ?? null,
        duplicateGroupSize: evidence.length,
        effectiveActive,
        reasonCode: effectiveActive
          ? "duplicate_name_canonical"
          : canonical
            ? "duplicate_name_historical_inactive"
            : "duplicate_name_empty_inactive",
        sourceActive: true,
      });
    }
  }
  return result;
}

function duplicateRoomTypeEvidence(
  context: PmsBuildContext,
  entry: { id: string; row: IdentitySourceRow },
): {
  id: string;
  capacity: number;
  live: boolean;
  nonCancelledBookings: number;
  updatedAt: string;
} {
  const rows = (table: string) => context.rowsByTable.get(table) ?? [];
  const references = (table: string) =>
    rows(table).filter((row) => String(row.data["room_type_id"] ?? "").toLowerCase() === entry.id);
  const snapshotDay = context.snapshotAt.slice(0, 10);
  const bookings = references("bookings");
  const futureBookings = bookings.filter((row) => {
    const status = String(row.data["status"] ?? "").toLowerCase();
    return (
      !["cancelled", "canceled", "no_show"].includes(status) &&
      String(row.data["check_out"] ?? "").slice(0, 10) >= snapshotDay
    );
  });
  const futureBlocks = references("room_blocks").filter(
    (row) => String(row.data["end_date"] ?? row.data["ends_on"] ?? "").slice(0, 10) >= snapshotDay,
  );
  const activeChannelMappings = [
    ...references("channex_room_type_mappings"),
    ...references("channex_rate_plan_mappings"),
  ].filter((row) => row.data["is_active"] !== false);
  const physicalRooms = references("rooms").length;
  return {
    id: entry.id,
    capacity: Math.max(physicalRooms, integer(entry.row.data["total_rooms"], "total_rooms", 0)),
    live: futureBookings.length > 0 || futureBlocks.length > 0 || activeChannelMappings.length > 0,
    nonCancelledBookings: bookings.filter(
      (row) =>
        !["cancelled", "canceled", "no_show"].includes(
          String(row.data["status"] ?? "").toLowerCase(),
        ),
    ).length,
    updatedAt: iso(entry.row.data["updated_at"], "updated_at"),
  };
}

function compareDuplicateRoomTypeEvidence(
  left: ReturnType<typeof duplicateRoomTypeEvidence>,
  right: ReturnType<typeof duplicateRoomTypeEvidence>,
): number {
  return (
    right.capacity - left.capacity ||
    right.nonCancelledBookings - left.nonCancelledBookings ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

function roomTypeCurrencyDispositions(
  context: PmsBuildContext,
): Map<string, RoomTypeCurrencyDisposition> {
  const groups = new Map<
    string,
    Array<{ id: string; row: IdentitySourceRow; sourceActive: boolean; sourceCurrency: string }>
  >();
  for (const row of context.rowsByTable.get("room_types") ?? []) {
    try {
      const id = uuid(row.data["id"], "id");
      const propertyId = propertyForHotel(context, row.data["hotel_id"]);
      const entry = {
        id,
        row,
        sourceActive: bool(row.data["is_active"], "is_active", true),
        sourceCurrency: currency(row.data["currency"] ?? "EUR"),
      };
      groups.set(propertyId, [...(groups.get(propertyId) ?? []), entry]);
    } catch {
      // The normal row builder records malformed source fields as blockers.
    }
  }

  const result = new Map<string, RoomTypeCurrencyDisposition>();
  for (const group of groups.values()) {
    const groupCurrencies = [...new Set(group.map((entry) => entry.sourceCurrency))].sort();
    const evidence = group.flatMap((entry) => {
      try {
        return [{ ...entry, ...duplicateRoomTypeEvidence(context, entry) }];
      } catch (error) {
        addPmsBlocker(
          context,
          "INVALID_SOURCE_ROW",
          "pms.room_types",
          entry.id,
          error instanceof Error ? error.message : "Invalid room type evidence",
        );
        return [];
      }
    });
    if (evidence.length !== group.length) continue;
    const inactiveLive = evidence.filter((entry) => entry.live && !entry.sourceActive);
    for (const entry of inactiveLive)
      addPmsBlocker(
        context,
        "INACTIVE_ROOM_TYPE_HAS_LIVE_EVIDENCE",
        "pms.room_types",
        entry.id,
        "An inactive room type retains future or channel evidence",
      );
    if (inactiveLive.length > 0 || groupCurrencies.length < 2) continue;
    const liveCurrencies = [
      ...new Set(evidence.filter((entry) => entry.live).map((entry) => entry.sourceCurrency)),
    ];
    if (liveCurrencies.length > 1) {
      for (const entry of evidence.filter((candidate) => candidate.live))
        addPmsBlocker(
          context,
          "MULTIPLE_LIVE_ROOM_TYPE_CURRENCIES",
          "pms.room_types",
          entry.id,
          "Multiple pricing currencies retain future or channel evidence for one property",
        );
      continue;
    }
    const activeCurrencies = [
      ...new Set(
        evidence.filter((entry) => entry.sourceActive).map((entry) => entry.sourceCurrency),
      ),
    ];
    const retainedCurrency =
      liveCurrencies[0] ?? (activeCurrencies.length === 1 ? activeCurrencies[0]! : null);
    for (const entry of evidence) {
      let currencyEligibleActive = entry.sourceActive;
      let reasonCode: RoomTypeCurrencyDisposition["reasonCode"];
      if (liveCurrencies[0]) {
        currencyEligibleActive = entry.sourceActive && entry.sourceCurrency === liveCurrencies[0];
        reasonCode =
          entry.sourceCurrency === liveCurrencies[0]
            ? "live_currency_retained"
            : "conflicting_currency_historical_inactive";
      } else if (activeCurrencies.length > 1) {
        currencyEligibleActive = false;
        reasonCode = "ambiguous_currency_group_inactive";
      } else if (entry.sourceActive) {
        reasonCode = "sole_active_currency_retained";
      } else {
        reasonCode = "historical_currency_inactive";
      }
      context.effectiveRoomTypeActiveById.set(
        entry.id,
        (context.effectiveRoomTypeActiveById.get(entry.id) ?? entry.sourceActive) &&
          currencyEligibleActive,
      );
      result.set(entry.id, {
        currencyEligibleActive,
        groupCurrencies,
        reasonCode,
        retainedCurrency,
        sourceActive: entry.sourceActive,
        sourceCurrency: entry.sourceCurrency,
      });
    }
  }
  return result;
}

function linkedGroup(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const id = uuid(source.data["id"], "id");
  const propertyId = propertyForHotel(context, source.data["hotel_id"]);
  const createdAt = iso(source.data["created_at"], "created_at");
  const updatedAt = iso(source.data["updated_at"], "updated_at");
  return [
    pmsRecord(source, "linked_inventory_groups", id, updatedAt, true, {
      id,
      propertyId,
      name: requiredText(source.data["name"], "name"),
      revision: 1,
      createdAt,
      updatedAt,
    }),
  ];
}

function roomType(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  duplicateNameDisposition?: RoomTypeDuplicateNameDisposition,
  currencyDisposition?: RoomTypeCurrencyDisposition,
): { roomTypeId: string; flexiblePlanId: string; records: PmsTargetRecord[] } {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  const mediaVisibility =
    ownerStatusForHotel(context, data["hotel_id"]) === "active" ? "public" : "private";
  const linkedGroupId = context.linkedGroupByRoomType.get(id) ?? null;
  if (linkedGroupId) {
    const group = context.rowsByTable
      .get("linked_inventory_groups")
      ?.find((row) => String(row.data["id"]).toLowerCase() === linkedGroupId);
    if (!group || propertyForHotel(context, group.data["hotel_id"]) !== propertyId)
      throw new Error("linked inventory group belongs to another property");
  }
  const createdAt = iso(data["created_at"], "created_at");
  const updatedAt = iso(data["updated_at"], "updated_at");
  const roomCurrency = currency(data["currency"] ?? "EUR");
  const baseRate = money(data["base_rate"] ?? 0, "base_rate");
  const effectiveActive =
    context.effectiveRoomTypeActiveById.get(id) ?? bool(data["is_active"], "is_active", true);
  const ignoredSeasonIndices = ignoredLegacySeasonIndices(data);
  const legacyPricing = {
    ...pricingSnapshot(data),
    ...(ignoredSeasonIndices.length ? { ignoredSeasonIndices } : {}),
  };
  const flexibleCancellation = cancellationPolicy(context, data, "flexible");
  const imageQuarantine = matchingImageQuarantine(context, id, data["images"]);
  const legacyImages = imageQuarantine ? [] : jsonArray(data["images"], "images");
  if (legacyImages.some((value) => typeof value !== "string"))
    throw new Error("images must contain only URL strings");
  if (legacyImages.length > 20) throw new Error("images exceeds the 20-image target limit");
  const media = legacyImages.map((_, index) =>
    pmsMediaForSource(context, {
      sourceTable: "room_types",
      sourceRowId: `${id}:images:${index + 1}`,
      purpose: "pms.room_type.media",
      propertyId,
      visibility: mediaVisibility,
    }),
  );
  const mediaAssignments = media.map((item, index) =>
    pmsRecord(
      source,
      "room_type_media",
      `${id}:${item.mediaObjectId}`,
      updatedAt,
      true,
      {
        propertyId,
        roomTypeId: id,
        platformMediaObjectId: item.mediaObjectId,
        altText: null,
        sortOrder: index,
        createdAt,
        updatedAt,
      },
      { row: data, mediaObjectId: item.mediaObjectId, sortOrder: index },
    ),
  );
  const roomRecord = pmsRecord(
    source,
    "room_types",
    id,
    updatedAt,
    true,
    {
      id,
      propertyId,
      sourceSystem: "pms",
      sourceRoomTypeId: id,
      name: requiredText(data["name"], "name"),
      description: optionalText(data["description"], "description") ?? "",
      category: optionalText(data["category"], "category"),
      occupancyLimits: {
        maxOccupancy: integer(data["max_occupancy"], "max_occupancy", 2),
        maxAdults: nullableInteger(data["max_adults"], "max_adults"),
        maxChildren: nullableInteger(data["max_children"], "max_children"),
      },
      roomAttributes: {
        shortDescription: optionalText(data["short_description"], "short_description"),
        size: integer(data["size"], "size", 0),
        bedType: optionalText(data["bed_type"], "bed_type"),
        features: jsonArray(data["features"], "features"),
        benefits: jsonArray(data["benefits"], "benefits"),
        bedrooms: integer(data["bedrooms"], "bedrooms", 1),
        bathrooms: integer(data["bathrooms"], "bathrooms", 1),
        legacyPricing,
        ...(duplicateNameDisposition
          ? { legacyRoomTypeDisposition: { ...duplicateNameDisposition, effectiveActive } }
          : {}),
        ...(currencyDisposition
          ? { legacyCurrencyDisposition: { ...currencyDisposition, effectiveActive } }
          : {}),
        ...(imageQuarantine
          ? {
              legacyMediaDisposition: {
                reasonCode: imageQuarantine.reasonCode,
                sourceValueSha256: imageQuarantine.sourceValueSha256,
              },
            }
          : {}),
      },
      amenitiesSnapshot: jsonArray(data["amenities"], "amenities"),
      mediaSnapshot: media.map((item) => ({
        mediaObjectId: item.mediaObjectId,
        url: mediaVisibility === "public" ? item.publicUrl : null,
        source: "pms",
        sourceTable: "room_types",
        publicApproved: mediaVisibility === "public",
      })),
      baseRateAmount: baseRate,
      currency: roomCurrency,
      active: effectiveActive,
      sortOrder: integer(data["sort_order"], "sort_order", 0),
      locationSummary: {
        address: optionalText(data["location_address"], "location_address"),
        latitude: nullableNumber(data["latitude"], "latitude"),
        longitude: nullableNumber(data["longitude"], "longitude"),
      },
      linkedInventoryGroupId: linkedGroupId,
      createdAt,
      updatedAt,
    },
    { row: data, linkedGroupId, duplicateNameDisposition },
  );
  const flexiblePlanId = deterministicUuid("production-pms", "rate-plan", id, "flexible");
  const plans = [
    pmsRecord(
      source,
      "rate_plans",
      flexiblePlanId,
      updatedAt,
      true,
      {
        id: flexiblePlanId,
        propertyId,
        roomTypeId: id,
        code: "LEGACY-FLEX",
        name: "Legacy flexible rate",
        rateType: "flexible",
        mealPlan: null,
        paymentPolicy: jsonMap(data["rate_payment_methods"], "rate_payment_methods"),
        depositPolicy: ratePolicy(data, "flexible"),
        cancellationPolicySnapshot: flexibleCancellation,
        baseRateAmount: baseRate,
        currency: roomCurrency,
        active:
          effectiveActive && bool(data["flexible_rate_enabled"], "flexible_rate_enabled", true),
        createdAt,
        updatedAt,
      },
      { roomType: data, cancellationPolicy: flexibleCancellation, effectiveActive },
    ),
  ];
  if (
    bool(data["non_refundable_enabled"], "non_refundable_enabled", false) ||
    (data["non_refundable_rate"] !== null && data["non_refundable_rate"] !== undefined)
  ) {
    const planId = deterministicUuid("production-pms", "rate-plan", id, "non-refundable");
    const nonRefundableCancellation = cancellationPolicy(context, data, "non_refundable");
    plans.push(
      pmsRecord(
        source,
        "rate_plans",
        planId,
        updatedAt,
        true,
        {
          id: planId,
          propertyId,
          roomTypeId: id,
          code: "LEGACY-NRF",
          name: "Legacy non-refundable rate",
          rateType: "non_refundable",
          mealPlan: null,
          paymentPolicy: jsonMap(data["rate_payment_methods"], "rate_payment_methods"),
          depositPolicy: ratePolicy(data, "non_refundable"),
          cancellationPolicySnapshot: nonRefundableCancellation,
          baseRateAmount: nonRefundableRate(data, baseRate),
          currency: roomCurrency,
          active:
            effectiveActive &&
            bool(data["non_refundable_enabled"], "non_refundable_enabled", false),
          createdAt,
          updatedAt,
        },
        { roomType: data, cancellationPolicy: nonRefundableCancellation, effectiveActive },
      ),
    );
  }
  return {
    roomTypeId: id,
    flexiblePlanId,
    records: [
      roomRecord,
      ...mediaAssignments,
      ...plans,
      ...rateRules(context, source, flexiblePlanId, baseRate),
    ],
  };
}

function room(context: PmsBuildContext, source: IdentitySourceRow): PmsTargetRecord[] {
  const data = source.data;
  const id = uuid(data["id"], "id");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  const parent = context.roomTypeById.get(roomTypeId);
  if (!parent || propertyForHotel(context, parent.data["hotel_id"]) !== propertyId)
    throw new Error("room references a missing or cross-property room type");
  const status = requiredText(data["status"] ?? "available", "status").toLowerCase();
  if (!["available", "maintenance", "out_of_order"].includes(status))
    throw new Error(`room status ${status} is unsupported`);
  const createdAt = iso(data["created_at"], "created_at");
  const updatedAt = iso(data["updated_at"], "updated_at");
  const roomTypeActive =
    context.effectiveRoomTypeActiveById.get(roomTypeId) ??
    bool(parent.data["is_active"], "room_type.is_active", true);
  const effectiveStatus = roomTypeActive ? status : "retired";
  return [
    pmsRecord(source, "rooms", id, updatedAt, true, {
      id,
      propertyId,
      roomTypeId,
      sourceSystem: "pms",
      sourceRoomId: id,
      roomNumber: requiredText(data["room_number"], "room_number"),
      floor: optionalText(data["floor"], "floor"),
      status: effectiveStatus,
      sortOrder: integer(data["sort_order"], "sort_order", 0),
      roomMetadata: roomTypeActive
        ? {}
        : { legacySourceStatus: status, reasonCode: "parent_room_type_inactive" },
      createdAt,
      updatedAt,
    }),
  ];
}

function channelPlan(
  context: PmsBuildContext,
  source: IdentitySourceRow,
): { mappingId: string; planId: string; record: PmsTargetRecord } {
  const data = source.data;
  const mappingId = uuid(data["id"], "id");
  const roomTypeId = uuid(data["room_type_id"], "room_type_id");
  const parent = context.roomTypeById.get(roomTypeId);
  if (!parent) throw new Error("channel rate mapping references a missing room type");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  if (propertyForHotel(context, parent.data["hotel_id"]) !== propertyId)
    throw new Error("channel rate mapping crosses properties");
  const planId = deterministicUuid("production-pms", "channel-rate-plan", mappingId);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const planName = optionalText(data["plan_name"], "plan_name") ?? "Legacy channel rate";
  return {
    mappingId,
    planId,
    record: pmsRecord(
      source,
      "rate_plans",
      planId,
      updatedAt,
      true,
      {
        id: planId,
        propertyId,
        roomTypeId,
        code: `CH-${mappingId.slice(0, 8).toUpperCase()}`,
        name: planName,
        rateType: /non.?refundable/i.test(planName) ? "non_refundable" : "manual",
        mealPlan:
          data["meal_plan_code"] === null || data["meal_plan_code"] === undefined
            ? null
            : `legacy:${integer(data["meal_plan_code"], "meal_plan_code")}`,
        paymentPolicy: {},
        depositPolicy: {},
        cancellationPolicySnapshot: {},
        baseRateAmount: money(parent.data["base_rate"] ?? 0, "base_rate"),
        currency: currency(parent.data["currency"] ?? "EUR"),
        active:
          context.effectiveRoomTypeActiveById.get(roomTypeId) ??
          bool(parent.data["is_active"], "is_active", true),
        createdAt: iso(data["created_at"], "created_at"),
        updatedAt,
      },
      {
        mapping: data,
        parent: parent.data,
        effectiveActive: context.effectiveRoomTypeActiveById.get(roomTypeId) ?? null,
      },
    ),
  };
}

function rateRules(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  flexiblePlanId: string,
  baseRate: string,
): PmsTargetRecord[] {
  const data = source.data;
  const roomTypeId = uuid(data["id"], "id");
  const propertyId = propertyForHotel(context, data["hotel_id"]);
  const updatedAt = iso(data["updated_at"], "updated_at");
  const bounded = horizon(context.completedAt);
  const result: PmsTargetRecord[] = [];
  const add = (suffix: string, row: Record<string, unknown>) =>
    result.push(
      pmsRecord(
        source,
        "rate_rules",
        deterministicUuid("production-pms", "rate-rule", roomTypeId, suffix),
        updatedAt,
        true,
        {
          id: deterministicUuid("production-pms", "rate-rule", roomTypeId, suffix),
          propertyId,
          roomTypeId,
          ratePlanId: flexiblePlanId,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
          closedToArrival: false,
          closedToDeparture: false,
          priceDeltaAmount: null,
          priceDeltaPercent: null,
          ...row,
          createdAt: iso(data["created_at"], "created_at"),
          updatedAt,
        },
      ),
    );
  add("legacy-contract", {
    ruleType: "stay_restriction",
    startsOn: bounded.from,
    endsOn: bounded.through,
    minStayNights: positiveInteger(data["min_stay"], "min_stay"),
    maxStayNights: positiveInteger(data["max_stay"], "max_stay"),
    closedToArrival: bool(data["closed_to_arrival"], "closed_to_arrival", false),
    closedToDeparture: bool(data["closed_to_departure"], "closed_to_departure", false),
    rulePayload: pricingSnapshot(data),
  });
  for (const [day, amount] of Object.entries(jsonMap(data["daily_rates"], "daily_rates"))) {
    const stayDate = date(day, "daily_rate date");
    add(`daily:${stayDate}`, {
      ruleType: "daily_rate",
      startsOn: stayDate,
      endsOn: stayDate,
      minStayNights: null,
      maxStayNights: null,
      priceDeltaAmount: (Number(amount) - Number(baseRate)).toFixed(2),
      rulePayload: { sourceAmount: signedDecimal(amount, "daily rate") },
    });
  }
  for (const [index, season] of jsonArray(data["seasons"], "seasons").entries()) {
    if (!season || typeof season !== "object" || Array.isArray(season))
      throw new Error(`seasons[${index}] must be an object`);
    const value = season as Record<string, unknown>;
    if (ignoredLegacySeasonReason(value)) continue;
    for (const [occurrence, range] of recurringDateRanges(
      value["from"],
      value["to"],
      bounded,
    ).entries())
      add(`season:${index}:${occurrence}`, {
        ruleType: "season",
        startsOn: range.startsOn,
        endsOn: range.endsOn,
        minStayNights: positiveInteger(value["minStay"] ?? value["min_stay"], "season min stay"),
        maxStayNights: positiveInteger(value["maxStay"] ?? value["max_stay"], "season max stay"),
        priceDeltaAmount: seasonDelta(value["rate"], baseRate),
        rulePayload: value,
      });
  }
  const weekend = parseWeekend(data["weekend_surcharge"]);
  if (weekend !== 0)
    add("weekend", {
      ruleType: "weekend_surcharge",
      startsOn: bounded.from,
      endsOn: bounded.through,
      daysOfWeek: [5, 6],
      minStayNights: null,
      maxStayNights: null,
      priceDeltaPercent: percentage(weekend, "weekend_surcharge"),
      rulePayload: { source: data["weekend_surcharge"] },
    });
  const advance = integer(data["minimum_advance_days"], "minimum_advance_days", 0);
  if (advance > 0)
    add("advance", {
      ruleType: "advance_booking",
      startsOn: bounded.from,
      endsOn: bounded.through,
      minStayNights: null,
      maxStayNights: null,
      rulePayload: { minimumAdvanceDays: advance },
    });
  const lastMinute = data["last_minute_discount"];
  if (lastMinute !== null && lastMinute !== undefined)
    add("last-minute", {
      ruleType: "last_minute_discount",
      startsOn: bounded.from,
      endsOn: bounded.through,
      minStayNights: null,
      maxStayNights: null,
      rulePayload: jsonMap(lastMinute, "last_minute_discount"),
    });
  return result;
}

function ignoredLegacySeasonIndices(data: Record<string, unknown>): number[] {
  return jsonArray(data["seasons"], "seasons").flatMap((season, index) => {
    if (!season || typeof season !== "object" || Array.isArray(season)) return [];
    return ignoredLegacySeasonReason(season as Record<string, unknown>) ? [index] : [];
  });
}

function ignoredLegacySeasonReason(value: Record<string, unknown>): boolean {
  // Deployed legacy pricing treats a season without both boundaries as non-covering.
  return (
    typeof value["from"] !== "string" ||
    !value["from"].trim() ||
    typeof value["to"] !== "string" ||
    !value["to"].trim()
  );
}

function matchingImageQuarantine(context: PmsBuildContext, roomTypeId: string, value: unknown) {
  return context.target.mediaQuarantines?.find(
    (quarantine) =>
      quarantine.sourceTable === "room_types" &&
      quarantine.sourceRowId === `${roomTypeId}:images` &&
      quarantine.sourceField === "images" &&
      quarantine.purpose === "pms.room_type.media" &&
      quarantine.reasonCode === "INVALID_STRING_ARRAY" &&
      quarantine.sourceValueSha256 === sha256({ value }),
  );
}

function pricingSnapshot(data: Record<string, unknown>): Record<string, unknown> {
  return {
    monthlyRates: jsonMap(data["monthly_rates"], "monthly_rates"),
    dailyRates: jsonMap(data["daily_rates"], "daily_rates"),
    operatingPeriods: jsonArray(data["operating_periods"], "operating_periods"),
    seasons: jsonArray(data["seasons"], "seasons"),
    weekendSurcharge: data["weekend_surcharge"] ?? "+0%",
    cancellationPolicy: data["cancellation_policy"] ?? null,
    nonRefundableCancellationPolicy: data["non_refundable_cancellation_policy"] ?? null,
    partialRefundTiers: jsonArray(data["partial_refund_tiers"], "partial_refund_tiers"),
    lastMinuteDiscount:
      data["last_minute_discount"] === null || data["last_minute_discount"] === undefined
        ? null
        : jsonMap(data["last_minute_discount"], "last_minute_discount"),
    minimumAdvanceDays: integer(data["minimum_advance_days"], "minimum_advance_days", 0),
    ratePaymentMethods: jsonMap(data["rate_payment_methods"], "rate_payment_methods"),
    rateDepositSettings: jsonMap(data["rate_deposit_settings"], "rate_deposit_settings"),
    mealPlans: jsonArray(data["meal_plans"], "meal_plans"),
  };
}

function cancellationPolicy(
  context: PmsBuildContext,
  roomType: Record<string, unknown>,
  kind: "flexible" | "non_refundable",
): Record<string, unknown> {
  const hotelId = requiredText(roomType["hotel_id"], "hotel_id").toLowerCase();
  const policies = (context.rowsByTable.get("cancellation_policies") ?? []).filter(
    (row) => String(row.data["hotel_id"] ?? "").toLowerCase() === hotelId,
  );
  if (policies.length > 1) throw new Error("hotel has duplicate cancellation policies");
  return {
    kind,
    text:
      kind === "flexible"
        ? (roomType["cancellation_policy"] ?? null)
        : (roomType["non_refundable_cancellation_policy"] ?? null),
    flexibleCancellationType: roomType["flexible_cancellation_type"] ?? null,
    partialRefundCancelWindowDays: roomType["partial_refund_cancel_window_days"] ?? null,
    partialRefundAmountPercent: roomType["partial_refund_amount_percent"] ?? null,
    partialRefundTiers: jsonArray(roomType["partial_refund_tiers"], "partial_refund_tiers"),
    hotelPolicy: policies[0]?.data ?? null,
  };
}

function ratePolicy(data: Record<string, unknown>, kind: string): Record<string, unknown> {
  const settings = jsonMap(data["rate_deposit_settings"], "rate_deposit_settings");
  const value = settings[kind === "non_refundable" ? "nonrefundable" : kind];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonRefundableRate(data: Record<string, unknown>, baseRate: string): string {
  const discount = Number(data["non_refundable_discount"] ?? 0);
  if (discount > 0) return (Number(baseRate) * (1 - discount / 100)).toFixed(2);
  return money(data["non_refundable_rate"] ?? baseRate, "non_refundable_rate");
}

function positiveInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "" || Number(value) === 0) return null;
  const parsed = integer(value, field);
  if (parsed < 1) throw new Error(`${field} must be positive`);
  return parsed;
}

function nullableInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined || value === "" ? null : integer(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be numeric`);
  return parsed;
}

function parseWeekend(value: unknown): number {
  const text = String(value ?? "")
    .trim()
    .replace("+", "")
    .replace("%", "");
  if (!text) return 0;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new Error("weekend_surcharge is unsupported");
  return parsed;
}

function seasonDelta(value: unknown, baseRate: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) throw new Error("season rate must be non-negative");
  return (rate - Number(baseRate)).toFixed(2);
}

function append(
  context: PmsBuildContext,
  source: IdentitySourceRow,
  target: PmsTargetRecord[],
  build: () => PmsTargetRecord[],
): void {
  try {
    target.push(...build());
  } catch (error) {
    addPmsBlocker(
      context,
      "INVALID_SOURCE_ROW",
      `pms.${source.sourceTable}`,
      safePmsSourceId(source),
      error instanceof Error ? error.message : "Invalid PMS room source row",
    );
  }
}

import type {
  PmsOperatingCalendarPropertyProfileEvidencePort,
  PmsOperatingCalendarReadPort,
  PmsOperatingCalendarRoomEvidencePorts,
} from "@vayada/domain-pms";

import type { PmsOperatingCalendarRoutesOptions } from "../routes/pmsOperatingCalendar.js";
import {
  createPgPmsInventoryMaterializationAuthorizationPort,
  type PmsInventoryMaterializationAuthorizationPool,
} from "./pmsInventoryMaterializationAuthorization.js";
import { createPgPmsInventoryMaterializationRepository } from "./pmsInventoryMaterializationRepository.js";
import { createPgPmsOperatingCalendarCommandRepository } from "./pmsOperatingCalendarCommandRepository.js";
import { createPgPmsOperatingCalendarImpactService } from "./pmsOperatingCalendarImpact.js";

export type PmsOperatingCalendarProductionRuntime = Readonly<{
  routes: PmsOperatingCalendarRoutesOptions;
  close(): Promise<void>;
}>;

export function createPmsOperatingCalendarProductionRuntime(input: {
  enabled: boolean;
  connectionString: string;
  confirmationSecret: string;
  authorizationPool: PmsInventoryMaterializationAuthorizationPool;
  propertyProfileEvidence: PmsOperatingCalendarPropertyProfileEvidencePort;
  roomEvidence: PmsOperatingCalendarRoomEvidencePorts;
  operatingCalendar: PmsOperatingCalendarReadPort;
}): PmsOperatingCalendarProductionRuntime | null {
  if (!input.enabled) return null;
  const impact = createPgPmsOperatingCalendarImpactService({
    connectionString: input.connectionString,
    confirmationSecret: input.confirmationSecret,
    propertyProfileEvidence: input.propertyProfileEvidence,
    roomEvidence: input.roomEvidence,
  });
  const command = createPgPmsOperatingCalendarCommandRepository({
    connectionString: input.connectionString,
    propertyProfileEvidence: input.propertyProfileEvidence,
    roomEvidence: input.roomEvidence,
    impactConfirmation: impact,
  });
  const materialization = createPgPmsInventoryMaterializationRepository({
    connectionString: input.connectionString,
    authorization: createPgPmsInventoryMaterializationAuthorizationPort({
      pool: input.authorizationPool,
    }),
    operatingCalendar: input.operatingCalendar,
    propertyProfileEvidence: input.propertyProfileEvidence,
    roomCapacity: input.roomEvidence.roomCapacity,
  });
  return Object.freeze({
    routes: Object.freeze({
      commandPort: command,
      impactPreviewPort: impact,
      readPort: input.operatingCalendar,
      timeZoneRegistry: input.propertyProfileEvidence,
      materializationPort: materialization,
    }),
    async close() {
      await Promise.all([impact.close(), command.close(), materialization.close()]);
    },
  });
}

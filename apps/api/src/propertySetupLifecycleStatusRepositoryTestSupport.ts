import type { QueryResult, QueryResultRow } from "pg";

import type { PropertySetupLifecycleQueryExecutor } from "./domains/propertySetupLifecycleAuthorization.js";

export const lifecycleTestScope = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  propertyId: "10000000-0000-4000-8000-000000000002",
  actorUserId: "10000000-0000-4000-8000-000000000003",
});

export function authorizedLifecycleExecutor(
  row: QueryResultRow,
): PropertySetupLifecycleQueryExecutor {
  return new SequencedLifecycleExecutor([
    { rows: [{ id: lifecycleTestScope.propertyId }], rowCount: 1 },
    { rows: [row], rowCount: 1 },
  ]);
}

export class SequencedLifecycleExecutor implements PropertySetupLifecycleQueryExecutor {
  queryCount = 0;

  constructor(
    private readonly responses: Array<{
      rows: QueryResultRow[];
      rowCount: number;
    }>,
  ) {}

  async query<T extends QueryResultRow = QueryResultRow>(): Promise<
    Pick<QueryResult<T>, "rows" | "rowCount">
  > {
    const response = this.responses[this.queryCount++];
    if (!response) throw new Error("Unexpected query");
    return response as Pick<QueryResult<T>, "rows" | "rowCount">;
  }
}

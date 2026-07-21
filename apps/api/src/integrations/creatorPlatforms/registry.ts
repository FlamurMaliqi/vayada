import type { CreatorPlatformAdapter, CreatorPlatformProvider } from "./types.js";

export type CreatorPlatformAdapterRegistry = Readonly<
  Partial<Record<CreatorPlatformProvider, CreatorPlatformAdapter>>
>;

export function createCreatorPlatformAdapterRegistry(
  adapters: readonly CreatorPlatformAdapter[],
): CreatorPlatformAdapterRegistry {
  const registry: Partial<Record<CreatorPlatformProvider, CreatorPlatformAdapter>> = {};
  for (const adapter of adapters) {
    if (registry[adapter.provider]) {
      throw new Error(`Duplicate creator platform adapter: ${adapter.provider}`);
    }
    registry[adapter.provider] = adapter;
  }
  return Object.freeze(registry);
}

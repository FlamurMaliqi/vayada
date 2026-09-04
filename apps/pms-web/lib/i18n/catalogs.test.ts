import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import deMessages from "../../messages/de.json";
import enMessages from "../../messages/en.json";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoots = ["app", "components", "lib"].map((directory) => path.join(appRoot, directory));

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    if (!/\.[tj]sx?$/.test(entry.name) || /\.(test|spec)\.[tj]sx?$/.test(entry.name)) return [];
    return [entryPath];
  });
}

function staticallyReferencedKeys(): string[] {
  const keys = new Set<string>();
  for (const file of sourceRoots.flatMap(sourceFiles)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of Array.from(source.matchAll(/\bt\(\s*["'`]([^"'`$]+)["'`]/g))) {
      keys.add(match[1]);
    }
  }
  return Array.from(keys).sort();
}

describe("PMS localization catalogs", () => {
  it("defines every statically referenced key in English and German", () => {
    const keys = staticallyReferencedKeys();
    const missingEnglish = keys.filter((key) => !(key in enMessages));
    const missingGerman = keys.filter((key) => !(key in deMessages));

    expect(missingEnglish).toEqual([]);
    expect(missingGerman).toEqual([]);
  });

  it("keeps translated room-option keys aligned", () => {
    const prefix = "rooms.form.option.";
    const englishKeys = Object.keys(enMessages)
      .filter((key) => key.startsWith(prefix))
      .sort();
    const germanKeys = Object.keys(deMessages)
      .filter((key) => key.startsWith(prefix))
      .sort();

    expect(germanKeys).toEqual(englishKeys);
  });
});

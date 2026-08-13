#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = resolveRepoRoot(process.argv.slice(2));

const sourceFilePattern = /\.[cm]?[jt]sx?$/;
const forbiddenPackageRoots = [
  {
    path: "packages/dtos",
    message:
      "global DTO packages are forbidden; put domain contracts in packages/domain-* or shared HTTP primitives in packages/backend-http",
  },
  {
    path: "packages/shared-dtos",
    message:
      "global DTO packages are forbidden; put domain contracts in packages/domain-* or shared HTTP primitives in packages/backend-http",
  },
];

// Temporary exceptions must be explicit and traceable. Add only when an issue
// describes why the boundary cannot be enforced yet and when it will be removed.
const temporaryExceptions = [
  // {
  //   issue: "VAY-000",
  //   file: "packages/domain-booking/src/temporaryAdapter.ts",
  //   check: "Booking domain must not depend on PMS implementations or channels",
  //   rule: "PMS implementation import",
  //   reason: "Short-lived compatibility adapter while VAY-000 removes it.",
  // },
];

validateTemporaryExceptions(temporaryExceptions);

const checks = [
  {
    name: "Route adapters must not open product database internals directly",
    roots: ["apps/api/src/routes"],
    include: () => true,
    rules: [
      forbiddenPattern(
        "Legacy product database env",
        /\b(?:BOOKING|MARKETPLACE|PMS|CHANNEX)_DATABASE_URL\b/,
        "route adapters must use domain repositories/read models instead of product database URLs",
      ),
      forbiddenPattern(
        "Product table dependency",
        productTablePattern(),
        "route adapters must use domain repositories/read models instead of product table names",
      ),
    ],
  },
  {
    name: "Booking routes must not depend on PMS or channel-manager internals",
    roots: ["apps/api/src/routes"],
    include: (filePath) =>
      /(^|[/\\])booking[^/\\]*\.tsx?$/.test(filePath) ||
      filePath.includes(`${path.sep}booking${path.sep}`),
    rules: [
      forbiddenPattern(
        "PMS database env",
        /\bPMS_DATABASE_URL\b/,
        "use a Booking read model/interface instead of PMS_DATABASE_URL",
      ),
      forbiddenPattern(
        "Cross-domain database env",
        /\b(?:MARKETPLACE|PMS|CHANNEX)_DATABASE_URL\b/,
        "do not use another product domain's database URL from Booking route code",
      ),
      forbiddenPattern(
        "Channex symbol",
        /\bchannex\b/i,
        "keep Channex behind PMS connectivity contracts",
      ),
      forbiddenPattern(
        "PMS table dependency",
        productTablePattern(),
        "depend on a read model/interface instead of PMS or channel table names",
      ),
      forbiddenImport(
        "PMS or channel import",
        isPmsOrChannelImport,
        "route through Booking/domain services instead of PMS or Channex modules",
      ),
    ],
  },
  {
    name: "Booking domain must not depend on PMS implementations or channels",
    roots: ["packages/domain-booking/src", "apps/api/src/domains/booking"],
    include: () => true,
    rules: [
      forbiddenPattern(
        "Cross-domain database env",
        /\b(?:MARKETPLACE|PMS|CHANNEX)_DATABASE_URL\b/,
        "do not use another product domain's database URL from Booking domain code",
      ),
      forbiddenPattern(
        "Channex symbol",
        /\bchannex\b/i,
        "keep Channex behind PMS connectivity contracts",
      ),
      forbiddenPattern(
        "PMS table dependency",
        productTablePattern(),
        "depend on a read model/interface instead of PMS or channel table names",
      ),
      forbiddenImport(
        "PMS implementation import",
        isPmsImplementationImport,
        "depend on PMS contracts/ports, not PMS implementations or provider adapters",
      ),
      forbiddenImport(
        "Channel-manager import",
        isChannelManagerImport,
        "keep channel-manager integrations behind PMS connectivity contracts",
      ),
    ],
  },
  {
    name: "Marketplace domain must not depend on PMS implementations",
    roots: ["packages/domain-marketplace/src", "apps/api/src/domains/marketplace"],
    include: () => true,
    rules: [
      forbiddenPattern(
        "PMS database env",
        /\bPMS_DATABASE_URL\b/,
        "Marketplace domain must not open PMS database connections; use CollaborationAffiliatePort instead",
      ),
      forbiddenPattern(
        "PMS table dependency",
        productTablePattern(),
        "Marketplace domain must not reference PMS table names; use typed command/port boundaries",
      ),
      forbiddenImport(
        "PMS implementation import",
        isPmsImplementationImport,
        "Marketplace domain must not import PMS implementations or adapters; depend on CollaborationAffiliatePort, not PMS internals",
      ),
    ],
  },
  {
    name: "PMS operations must not write Booking guest PII tables directly",
    roots: ["apps/api/src/routes", "apps/api/src/domains/pms"],
    include: (filePath) =>
      /(^|[/\\])pmsOperations\.tsx?$/.test(filePath) ||
      filePath.includes(`${path.sep}domains${path.sep}pms${path.sep}`),
    rules: [
      forbiddenPattern(
        "Booking guest PII table mutation",
        bookingGuestPiiMutationPattern(),
        "call the BookingGuestPiiPort instead of mutating booking.booking_guests from PMS code",
      ),
    ],
  },
  {
    name: "Target product domains must not write identity tables directly",
    roots: [
      "apps/api/src/routes",
      "packages/domain-booking/src",
      "packages/domain-distribution/src",
      "packages/domain-finance/src",
      "packages/domain-hotels/src",
      "packages/domain-marketplace/src",
      "packages/domain-pms/src",
      "apps/api/src/domains/booking",
      "apps/api/src/domains/distribution",
      "apps/api/src/domains/finance",
      "apps/api/src/domains/hotels",
      "apps/api/src/domains/marketplace",
      "apps/api/src/domains/pms",
    ],
    include: () => true,
    rules: [
      forbiddenPattern(
        "Identity SQL table mutation",
        identitySqlMutationPattern(),
        "request an identity lifecycle command instead of mutating identity or legacy Auth DB tables",
      ),
      forbiddenPattern(
        "Identity query-builder table mutation",
        identityQueryBuilderMutationPattern(),
        "request an identity lifecycle command instead of mutating identity or legacy Auth DB tables",
      ),
    ],
  },
];

const violations = [];

for (const forbiddenRoot of forbiddenPackageRoots) {
  if (existsSync(path.join(repoRoot, forbiddenRoot.path))) {
    violations.push({
      check: "API contract ownership",
      rule: "Global DTO package",
      file: forbiddenRoot.path,
      line: 1,
      message: forbiddenRoot.message,
    });
  }
}

for (const check of checks) {
  for (const root of check.roots) {
    const absoluteRoot = path.join(repoRoot, root);
    if (!existsSync(absoluteRoot)) {
      continue;
    }

    for (const filePath of walkFiles(absoluteRoot)) {
      const relativePath = normalizeRepoPath(path.relative(repoRoot, filePath));
      if (!check.include(relativePath)) {
        continue;
      }

      const source = stripComments(readFileSync(filePath, "utf8"));
      const context = {
        repoRoot,
        file: relativePath,
        absoluteFile: filePath,
      };
      for (const rule of check.rules) {
        for (const violation of rule.find(source, context)) {
          const candidate = {
            check: check.name,
            rule: rule.name,
            file: relativePath,
            line: violation.line,
            message: violation.message,
          };
          if (!hasTemporaryException(candidate)) {
            violations.push(candidate);
          }
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Architecture boundary check failed:\n");
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.line} ${violation.message} (${violation.check}; ${violation.rule})`,
    );
  }
  console.error("\nSee engineering/booking-pms-domain-boundaries.md.");
  process.exit(1);
}

console.log("Architecture boundary check passed.");

function* walkFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const fullPath = path.join(directory, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      yield* walkFiles(fullPath);
    } else if (sourceFilePattern.test(entry)) {
      yield fullPath;
    }
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat(match.split(/\r?\n/).length - 1))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function toGlobalRegExp(pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function forbiddenPattern(name, pattern, message) {
  return {
    name,
    find(source) {
      const matches = [];
      const globalPattern = toGlobalRegExp(pattern);
      for (const match of source.matchAll(globalPattern)) {
        matches.push({
          line: lineNumberAt(source, match.index ?? 0),
          message,
        });
      }
      return matches;
    },
  };
}

function forbiddenImport(name, isForbidden, message) {
  return {
    name,
    find(source, context) {
      const matches = [];
      for (const match of source.matchAll(importSpecifierPattern())) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
        if (specifier && isForbidden(specifier, context)) {
          matches.push({
            line: lineNumberAt(source, match.index ?? 0),
            message: `${message}: ${specifier}`,
          });
        }
      }
      return matches;
    },
  };
}

function importSpecifierPattern() {
  return /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
}

function isPmsOrChannelImport(specifier, context) {
  const normalized = normalizeSpecifier(specifier);
  return (
    normalized === "@vayada/domain-pms" ||
    isPmsImplementationImport(specifier, context) ||
    isChannelManagerImport(specifier)
  );
}

function isPmsImplementationImport(specifier, context) {
  const normalized = normalizeSpecifier(specifier);
  if (normalized === "@vayada/domain-pms") {
    return false;
  }

  const resolvedImport = resolveRelativeImport(specifier, context);

  return (
    normalized.startsWith("@vayada/domain-pms/") ||
    normalized.includes("pms-api") ||
    normalized.includes("vayada-pms") ||
    isPathInside(resolvedImport, path.join(context.repoRoot, "apps/api/src/domains/pms")) ||
    isPathInside(resolvedImport, path.join(context.repoRoot, "packages/domain-pms/src")) ||
    /(^|[/\\])(?:domain-pms|pms)([/\\].*)?(adapter|adapters|client|clients|connector|connectors|implementation|implementations|integration|integrations|repository|repositories|service|services)([/\\]|$)/.test(
      normalized,
    )
  );
}

function isChannelManagerImport(specifier) {
  const normalized = normalizeSpecifier(specifier);
  return (
    normalized.includes("channex") ||
    normalized.includes("channel-manager") ||
    normalized.includes("channel_manager")
  );
}

function normalizeSpecifier(specifier) {
  return specifier.replaceAll("\\", "/").toLowerCase();
}

function normalizeRepoPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

function productTablePattern() {
  const tableName = String.raw`(?:pms\.)?(?:pms_\w+|channex_\w+|room_blocks|rate_plans|physical_rooms)`;
  const sqlKeyword = String.raw`\b(?:from|join|update|into|delete\s+from)\s+["'\`]?${tableName}\b`;
  const queryBuilderMethod = String.raw`\b(?:selectFrom|insertInto|updateTable|deleteFrom|innerJoin|leftJoin|rightJoin|fullJoin)\(\s*["'\`]${tableName}["'\`]`;

  return new RegExp(`${sqlKeyword}|${queryBuilderMethod}`, "i");
}

function identityTablePatternSource() {
  const identityTables = [
    "users",
    "external_identities",
    "organizations",
    "organization_memberships",
    "organization_resource_links",
    "role_permission_grants",
  ].join("|");
  const legacyAuthTables = [
    "users",
    "password_reset_tokens",
    "email_verification_codes",
    "email_verification_tokens",
    "email_change_tokens",
  ].join("|");

  return String.raw`(?:(?:"?identity"?\s*\.\s*)?"?(?:${identityTables})"?|"?(?:${legacyAuthTables})"?)`;
}

function identitySqlMutationPattern() {
  return new RegExp(
    String.raw`\b(?:insert\s+into|update|delete\s+from)\s+(?:${identityTablePatternSource()})\b`,
    "i",
  );
}

function identityQueryBuilderMutationPattern() {
  return new RegExp(
    String.raw`\b(?:insertInto|updateTable|deleteFrom)\(\s*["'\`](?:${identityTablePatternSource()})["'\`]`,
    "i",
  );
}

function bookingGuestPiiMutationPattern() {
  const table = String.raw`booking\s*\.\s*booking_guests`;
  return new RegExp(
    String.raw`\b(?:insert\s+into|update|delete\s+from)\s+${table}\b|\b(?:insertInto|updateTable|deleteFrom)\(\s*["'\`]booking\.booking_guests["'\`]`,
    "i",
  );
}

function resolveRelativeImport(specifier, context) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  return path.resolve(path.dirname(context.absoluteFile), specifier);
}

function isPathInside(candidate, parent) {
  if (!candidate) {
    return false;
  }

  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveRepoRoot(args) {
  const rootFlagIndex = args.indexOf("--root");
  if (rootFlagIndex === -1) {
    return process.cwd();
  }

  const root = args[rootFlagIndex + 1];
  if (!root) {
    console.error("Usage: node scripts/check-architecture-boundaries.mjs [--root <path>]");
    process.exit(2);
  }

  return path.resolve(root);
}

function validateTemporaryExceptions(exceptions) {
  for (const exception of exceptions) {
    const missing = ["issue", "file", "check", "rule", "reason"].filter((key) => !exception[key]);
    if (missing.length > 0) {
      throw new Error(`Invalid architecture-boundary exception; missing ${missing.join(", ")}`);
    }

    if (!/^VAY-\d+$/.test(exception.issue)) {
      throw new Error(
        `Invalid architecture-boundary exception for ${exception.file}; issue must look like VAY-123.`,
      );
    }
  }
}

function hasTemporaryException(violation) {
  const violationFile = normalizeRepoPath(violation.file);

  return temporaryExceptions.some(
    (exception) =>
      normalizeRepoPath(exception.file) === violationFile &&
      exception.check === violation.check &&
      exception.rule === violation.rule,
  );
}

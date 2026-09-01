import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { extractZip } = require("playwright-core/lib/coreBundle").utils;
const evidenceRoots = ["test-results", "playwright-report"];
const secretNames = ["NEXT_STACK_SMOKE_PASSWORD", "WORKOS_API_KEY"];
const secrets = secretNames.flatMap((name) => {
  const value = process.env[name]?.trim();
  if (!value) return [];
  return [
    { name, value },
    { name, value: encodeURIComponent(value) },
    { name, value: JSON.stringify(value).slice(1, -1) },
    { name, value: Buffer.from(value).toString("base64") },
  ].filter(
    ({ value: variant }, index, variants) =>
      variant.length >= 8 && variants.findIndex(({ value: seen }) => seen === variant) === index,
  );
});

if (!secrets.length) {
  throw new Error(`Set at least one of ${secretNames.join(", ")} before auditing evidence.`);
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "next-stack-smoke-evidence-"));
const findings = [];
let scannedFiles = 0;

try {
  for (const root of evidenceRoots) await scanPath(path.resolve(root));
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (findings.length) {
  const summary = findings.map(
    ({ file, name }) => `${path.relative(process.cwd(), file)}: ${name}`,
  );
  throw new Error(
    `Refusing to retain Playwright evidence containing configured secrets:\n${summary.join("\n")}`,
  );
}

console.log(`Verified ${scannedFiles} Playwright evidence files contain no configured secrets.`);

async function scanPath(target) {
  const details = await stat(target).catch(() => undefined);
  if (!details) return;
  if (details.isDirectory()) {
    for (const entry of await readdir(target)) await scanPath(path.join(target, entry));
    return;
  }
  if (!details.isFile()) return;

  scannedFiles += 1;
  const contents = await readFile(target);
  for (const secret of secrets) {
    if (contents.includes(Buffer.from(secret.value))) {
      findings.push({ file: target, name: secret.name });
    }
  }

  if (path.extname(target).toLowerCase() === ".zip") await scanZip(target);
  if (path.basename(target) === "index.html") await scanEmbeddedReport(target, contents);
}

async function scanZip(zipFile) {
  const destination = await mkdtemp(path.join(temporaryRoot, "zip-"));
  await extractZip(zipFile, { dir: destination });
  await scanPath(destination);
}

async function scanEmbeddedReport(reportFile, contents) {
  const match = contents
    .toString("utf8")
    .match(
      /<template id="playwrightReportBase64">data:application\/zip;base64,([^<]+)<\/template>/,
    );
  if (!match) return;
  const zipFile = path.join(
    await mkdtemp(path.join(temporaryRoot, "html-")),
    `${path.basename(reportFile)}.zip`,
  );
  await writeFile(zipFile, Buffer.from(match[1], "base64"));
  await scanZip(zipFile);
}

import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const startupScript = join(__dirname, "../../../scripts/start-next-api.sh");

describe("next-api deployment startup", () => {
  let fakeBin: string;
  let callLog: string;

  beforeEach(async () => {
    fakeBin = await mkdtemp(join(tmpdir(), "next-api-startup-"));
    callLog = join(fakeBin, "calls.log");
    const fakeNpm = join(fakeBin, "npm");
    await writeFile(
      fakeNpm,
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> "$START_NEXT_API_CALL_LOG"
case "$*" in
  *"@vayada/backend-migration"*) exit "\${FAKE_MIGRATION_EXIT_CODE:-0}" ;;
  *) exit 0 ;;
esac
`,
    );
    await chmod(fakeNpm, 0o755);
  });

  afterEach(async () => {
    await rm(fakeBin, { recursive: true, force: true });
  });

  function runStartup(migrationExitCode: number) {
    return spawnSync(startupScript, [], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPLICATION_RELEASE: "0123456789abcdef0123456789abcdef01234567",
        FAKE_MIGRATION_EXIT_CODE: String(migrationExitCode),
        PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
        START_NEXT_API_CALL_LOG: callLog,
      },
    });
  }

  it("starts the API only after the release migration succeeds", async () => {
    const result = runStartup(0);

    expect(result.status).toBe(0);
    expect((await readFile(callLog, "utf8")).trim().split("\n")).toEqual([
      "--workspace @vayada/backend-migration run target:migrate:dist -- --env production --git-sha 0123456789abcdef0123456789abcdef01234567",
      "--workspace vayada-api run start",
    ]);
  });

  it("blocks API startup when the release migration fails", async () => {
    const result = runStartup(42);

    expect(result.status).toBe(42);
    expect((await readFile(callLog, "utf8")).trim()).toContain("@vayada/backend-migration");
    expect(await readFile(callLog, "utf8")).not.toContain("vayada-api run start");
  });
});

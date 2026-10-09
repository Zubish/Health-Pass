import { spawnSync } from "node:child_process";
for (const engine of ["sqlite", "postgres"]) {
  console.log(`\nFoundation integration checks · ${engine}`);
  const result = spawnSync(process.execPath, ["tests/foundation.test.mjs"], {
    stdio: "inherit",
    env: { ...process.env, HEALTHPASS_TEST_ENGINE: engine },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

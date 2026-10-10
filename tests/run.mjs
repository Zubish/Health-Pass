import { spawnSync } from "node:child_process";
const functionChecks = spawnSync(process.execPath, ["tests/function.test.mjs"], {
  stdio: "inherit",
});
if (functionChecks.status !== 0) process.exit(functionChecks.status ?? 1);
for (const engine of ["sqlite", "postgres"]) {
  console.log(`\nFoundation integration checks · ${engine}`);
  const result = spawnSync(process.execPath, ["tests/foundation.test.mjs"], {
    stdio: "inherit",
    env: { ...process.env, HEALTHPASS_TEST_ENGINE: engine },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

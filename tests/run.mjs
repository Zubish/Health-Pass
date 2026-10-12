import { spawnSync } from "node:child_process";
const functionChecks = spawnSync(process.execPath, ["tests/function.test.mjs"], {
  stdio: "inherit",
});
if (functionChecks.status !== 0) process.exit(functionChecks.status ?? 1);
const proxyChecks = spawnSync(process.execPath, ["tests/proxy.test.mjs"], { stdio: "inherit" });
if (proxyChecks.status !== 0) process.exit(proxyChecks.status ?? 1);
for (const engine of ["sqlite", "postgres"]) {
  console.log(`\nFoundation integration checks · ${engine}`);
  for (const file of [
    "tests/foundation.test.mjs",
    "tests/workspaces.test.mjs",
    "tests/care-workflows.test.mjs",
    "tests/professional-access.test.mjs",
    "tests/care-handoffs.test.mjs",
    "tests/patient-onboarding.test.mjs",
    "tests/care-responsibilities.test.mjs",
  ]) {
    const result = spawnSync(process.execPath, [file], {
      stdio: "inherit",
      env: { ...process.env, HEALTHPASS_TEST_ENGINE: engine },
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

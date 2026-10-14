import { createApi, runtimeConfig } from "./api.mjs";
import { openStore } from "./store.mjs";

// Run on an approved scheduler. Each invocation performs bounded delivery/reconciliation.
const config = runtimeConfig(),
  store = await openStore(config);
try {
  const api = createApi({ store, config });
  const providers = await store.transact((state) =>
    state.users.filter((u) => u.role === "provider" && u.active),
  );
  let failures = 0;
  for (const provider of providers) {
    const result = await api.deliver(provider);
    if (result.reconciliation !== "ok" || result.results.some((r) => r.status !== "delivered"))
      failures++;
  }
  console.log(
    JSON.stringify({
      service: "healthpass-integration-worker",
      providersProcessed: providers.length,
      deliveryFailures: failures,
    }),
  );
  if (failures) process.exitCode = 1;
} finally {
  await store.close?.();
}

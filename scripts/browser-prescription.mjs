import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const base = process.env.HEALTHPASS_BROWSER_URL || "http://localhost:3100";
const password = process.env.HEALTHPASS_BROWSER_PASSWORD;
if (!password) throw Error("Set HEALTHPASS_BROWSER_PASSWORD for provisioned synthetic accounts");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage(),
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
async function login(email) {
  await page.goto(base + "/care");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
}
async function getWorkspace() {
  const response = await page.request.get(base + "/api/v1/workspace");
  assert.equal(response.status(), 200);
  return response.json();
}
try {
  await login("doctor@example.test");
  const patient = (await getWorkspace()).patients.find((p) => p.name === "Synthetic patient");
  await page.getByRole("combobox", { name: /^Patient/ }).selectOption(patient.id);
  await page
    .getByLabel("Encounter note", { exact: true })
    .fill("Synthetic browser encounter; professional review fixture only.");
  await page.getByRole("button", { name: "Save encounter", exact: true }).click();
  await page.getByRole("button", { name: "Sign encounter", exact: true }).first().click();
  await page.getByRole("status").filter({ hasText: "Encounter signed" }).waitFor();
  const encounter = (await getWorkspace()).encounters.find((e) => e.status === "signed");
  await page.getByRole("combobox", { name: /^Signed encounter/ }).selectOption(encounter.id);
  const fields = {
    "Valid until": new Date(Date.now() + 3600000).toISOString().slice(0, 16),
    "Medicine name": "Example",
    "Dosage form": "tablet",
    Strength: "5 mg",
    Dose: "1",
    "Dose unit": "tablet",
    Route: "oral",
    Frequency: "once daily",
    Duration: "10 days",
    "Quantity to supply": "10",
    "Dispensing unit": "tablet",
    Instructions: "Synthetic fixture only",
  };
  for (const [label, value] of Object.entries(fields))
    await page.getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Save prescription draft", exact: true }).click();
  await page
    .getByRole("button", { name: "Sign reviewed prescription", exact: true })
    .first()
    .click();
  await page.getByRole("status").filter({ hasText: "Prescription signed" }).waitFor();
  assert.equal((await getWorkspace()).prescriptions.at(-1).orderStatus, "active");
  mkdirSync("verification", { recursive: true });
  await page.screenshot({ path: "verification/provider-prescription.png", fullPage: true });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login("patient@example.test");
  await page
    .getByLabel("Consent expires", { exact: true })
    .fill(new Date(Date.now() + 3600000).toISOString().slice(0, 16));
  await page.getByRole("button", { name: "Allow prescription sharing", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Sharing consent recorded" }).waitFor();
  assert.equal((await getWorkspace()).consents.at(-1).purpose, "prescription_fulfilment");
  assert.equal(
    await page.getByRole("button", { name: "Sign reviewed prescription", exact: true }).count(),
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "verification/patient-prescription-mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Revoke", exact: true }).last().click();
  await page.getByRole("status").filter({ hasText: "Consent revoked" }).waitFor();
  assert.ok((await getWorkspace()).consents.at(-1).revokedAt);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: "passed",
      clinicianSigning: true,
      patientConsentAndRevocation: true,
      patientCannotSign: true,
      pageErrors: 0,
    }),
  );
} finally {
  await browser.close();
}

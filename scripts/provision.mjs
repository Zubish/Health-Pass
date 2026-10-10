import { openStore, newId } from "../server/store.mjs";
import { runtimeConfig } from "../server/api.mjs";
import { passwordHash, text } from "../server/security.mjs";
import { audit } from "../server/domain.mjs";

const config = runtimeConfig();
const demo = process.argv.includes("--synthetic");
if (demo && config.production) throw new Error("Synthetic fixtures are forbidden in production");
const password = process.env.HEALTHPASS_PROVISION_PASSWORD;
if (!password || password.length < 16)
  throw new Error("Set HEALTHPASS_PROVISION_PASSWORD to a password of at least 16 characters");
const store = await openStore(config);
try {
  await store.transact((state) => {
    if (demo) {
      if (state.users.length)
        throw new Error("Synthetic provisioning requires an empty development workspace");
      const patientId = newId("patient"),
        doctorId = newId("provider");
      state.users.push(
        {
          id: doctorId,
          name: "Synthetic clinician",
          email: "doctor@example.test",
          role: "provider",
          organizationId: state.organizationId,
          active: true,
          verificationReference: "SYNTHETIC-NOT-A-LICENCE",
          passwordHash: passwordHash(password),
        },
        {
          id: newId("account"),
          name: "Synthetic patient",
          email: "patient@example.test",
          role: "patient",
          patientId,
          organizationId: state.organizationId,
          active: true,
          passwordHash: passwordHash(password),
        },
      );
      state.patients.push({
        id: patientId,
        healthPassId: newId("HP"),
        name: "Synthetic patient",
        providerIds: [doctorId],
      });
      audit(state, "system:provisioning", "synthetic.accounts_created", doctorId, Date.now());
      return;
    }
    // Run by an authorized operator after separate identity/professional review.
    // This tool records supplied evidence; it does not claim to verify a licence.
    const email = text(process.env.HEALTHPASS_PROVISION_EMAIL, "email", 254).toLowerCase();
    const name = text(process.env.HEALTHPASS_PROVISION_NAME, "name", 200);
    const role = process.env.HEALTHPASS_PROVISION_ROLE;
    if (!["provider", "patient"].includes(role)) throw new Error("Choose provider or patient");
    if (state.users.some((u) => u.email.toLowerCase() === email))
      throw new Error("Account already exists");
    const user = {
      id: newId("user"),
      name,
      email,
      role,
      organizationId: state.organizationId,
      active: true,
      passwordHash: passwordHash(password),
    };
    if (role === "provider") {
      user.verificationReference = text(
        process.env.HEALTHPASS_VERIFICATION_REFERENCE,
        "reviewed verification reference",
        300,
      );
      user.mfaSecret = text(
        process.env.HEALTHPASS_PROVISION_TOTP_SECRET,
        "TOTP enrollment secret",
        100,
      );
      if (!/^[A-Z2-7]{32,64}$/.test(user.mfaSecret))
        throw new Error("Use a securely generated base32 TOTP secret, enrolled privately");
    } else {
      const patient = state.patients.find(
        (p) => p.id === process.env.HEALTHPASS_PROVISION_PATIENT_ID,
      );
      if (!patient)
        throw new Error("Patient account must reference an existing reviewed patient identity");
      user.patientId = patient.id;
    }
    state.users.push(user);
    audit(state, "system:provisioning", "account.provisioned", user.id, Date.now());
  });
  console.log(
    demo
      ? "Synthetic accounts created: doctor@example.test and patient@example.test. Use the password you supplied."
      : "Reviewed account provisioned. No credentials printed.",
  );
} finally {
  await store.close?.();
}

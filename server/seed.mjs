import { createDefaultRoles } from "./roles.mjs";
import { randomUUID } from "node:crypto";
import { openDatabase } from "./db.mjs";
import { passwordHash } from "./security.mjs";

export async function seed(db, password) {
  if (!password || password.length < 12)
    throw new Error("Set HEALTHPASS_DEMO_PASSWORD to at least 12 characters.");
  await db.transaction(async (tx) => {
    if (await tx.get("SELECT id FROM users LIMIT 1"))
      throw new Error("Seed requires an empty database.");
    const now = new Date().toISOString();
    for (const [id, name] of [
      ["org-lagos", "Lagos Primary Care · Demo"],
      ["org-ibadan", "Ibadan Family Clinic · Demo"],
    ]) {
      await tx.run("INSERT INTO organizations(id,name,workspace_code) VALUES (?,?,?)", [
        id,
        name,
        "HP-" + id.toUpperCase(),
      ]);
      await tx.run("INSERT INTO branches(id,organization_id,name) VALUES (?,?,?)", [
        "main-" + id,
        id,
        "Main branch",
      ]);
    }
    for (const [id, hp, name, org, allergy, details] of [
      [
        "patient-ade",
        "HP-DEMO-001",
        "Adé Okafor (synthetic)",
        "org-lagos",
        "reviewed",
        "Penicillin — patient reports rash; verify before prescribing.",
      ],
      ["patient-zainab", "HP-DEMO-002", "Zainab Bello (synthetic)", "org-lagos", "unknown", ""],
      ["patient-tunde", "HP-DEMO-003", "Tunde Ajayi (synthetic)", "org-ibadan", "unknown", ""],
    ]) {
      await tx.run(
        "INSERT INTO patients(id,healthpass_id,name,dob,phone,allergy_status,allergies,created_at) VALUES (?,?,?,?,?,?,?,?)",
        [id, hp, name, "1990-01-01", null, allergy, details, now],
      );
      await tx.run(
        "INSERT INTO patient_links(patient_id,organization_id,created_at) VALUES (?,?,?)",
        [id, org, now],
      );
    }
    for (const [id, email, name, patient, org, role] of [
      ["doctor-lagos", "doctor@healthpass.test", "Dr. Ada Nwosu", null, "org-lagos", "clinician"],
      [
        "doctor-ibadan",
        "ibadan@healthpass.test",
        "Dr. Femi Adeyemi",
        null,
        "org-ibadan",
        "clinician",
      ],
      ["reception", "reception@healthpass.test", "Seyi Martins", null, "org-lagos", "reception"],
      [
        "admin",
        "admin@healthpass.test",
        "Facility administrator",
        null,
        "org-lagos",
        "administrator",
      ],
      ["patient-user", "patient@healthpass.test", "Adé Okafor", "patient-ade", null, null],
    ]) {
      await tx.run(
        "INSERT INTO users(id,email,name,password_hash,patient_id,verified) VALUES (?,?,?,?,?,1)",
        [id, email, name, passwordHash(password), patient],
      );
      if (org)
        await tx.run("INSERT INTO memberships(id,user_id,organization_id,role) VALUES (?,?,?,?)", [
          randomUUID(),
          id,
          org,
          role,
        ]);
    }
    for (const org of ["org-lagos", "org-ibadan"]) await createDefaultRoles(tx, org);
    await tx.run(
      "INSERT INTO membership_roles(membership_id,role_id) SELECT id,'role-' || organization_id || '-' || role FROM memberships",
    );
    await tx.run("UPDATE memberships SET is_owner=1 WHERE role='administrator'");
    await tx.run(
      "UPDATE memberships SET clinical_verified=1,clinical_scopes='[\"general\"]',clinical_review_reference='Synthetic reviewed clinical fixture' WHERE role='clinician'",
    );
    await tx.run(
      "UPDATE users SET login_email=email,account_scope=COALESCE((SELECT organization_id FROM memberships WHERE user_id=users.id LIMIT 1),'patient')",
    );
    await tx.run(
      "INSERT INTO branch_patient_links(branch_id,patient_id) SELECT 'main-' || organization_id,patient_id FROM patient_links",
    );
  });
}
if (process.argv[1]?.endsWith("/seed.mjs")) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Synthetic seed is disabled in production.");
  const db = await openDatabase();
  try {
    await seed(db, process.env.HEALTHPASS_DEMO_PASSWORD);
    console.log("Synthetic fixtures created. See docs/foundation.md for accounts.");
  } finally {
    await db.close();
  }
}

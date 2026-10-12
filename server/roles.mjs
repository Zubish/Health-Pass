export const permissionCatalog = [
  { key: "areas.manage", label: "Manage departments and wards", category: "operational" },
  {
    key: "admissions.manage",
    label: "Manage admission episodes and care teams",
    category: "operational",
  },
  {
    key: "admissions.view",
    label: "View admission episodes and assigned care teams",
    category: "operational",
  },
  { key: "referrals.create", label: "Refer outpatients to consultants", category: "clinical" },
  {
    key: "referrals.respond",
    label: "Accept, schedule and decline consultant referrals",
    category: "clinical",
  },

  {
    key: "careteam.view",
    label: "View responsible consultants and care teams",
    category: "operational",
  },
  {
    key: "careteam.manage",
    label: "Assign and manage responsible consultants",
    category: "operational",
  },
  {
    key: "primary.manage",
    label: "Accept or decline primary care relationships",
    category: "operational",
  },
  { key: "registry.view", label: "View patient registry", category: "operational" },
  { key: "registry.create", label: "Register patients", category: "operational" },
  { key: "visits.view", label: "View arrival queue", category: "operational" },
  { key: "visits.manage", label: "Check in and route visits", category: "operational" },
  { key: "visits.document", label: "Document assigned visits", category: "clinical" },
  {
    key: "observations.create",
    label: "Record observations for assigned visits",
    category: "clinical",
  },
  { key: "followups.manage", label: "Manage assigned visit follow-up", category: "clinical" },
  { key: "records.view", label: "View clinical records", category: "clinical" },
  { key: "profile.edit", label: "Review allergies and patient context", category: "clinical" },
  { key: "notes.create", label: "Create clinical note drafts", category: "clinical" },
  { key: "notes.edit", label: "Edit own clinical note drafts", category: "clinical" },
  { key: "notes.sign", label: "Sign own clinical notes", category: "clinical" },
  { key: "notes.amend", label: "Amend own signed clinical notes", category: "clinical" },
  { key: "audit.view", label: "View own activity history", category: "operational" },
  { key: "audit.manage", label: "View facility audit history", category: "operational" },
  { key: "workspace.view", label: "View workspace and branches", category: "operational" },
  { key: "branches.manage", label: "Create branches", category: "operational" },
  { key: "staff.manage", label: "Review and manage staff access", category: "operational" },
  { key: "roles.manage", label: "Create and edit workspace roles", category: "operational" },
];
export const roleTemplates = [
  {
    key: "administrator",
    name: "Workspace administrator",
    description: "Manage staff, roles and branches; no clinical access.",
    clinical_scope: null,
    permissions: [
      "areas.manage",
      "admissions.manage",
      "admissions.view",
      "careteam.manage",
      "primary.manage",
      "workspace.view",
      "branches.manage",
      "staff.manage",
      "roles.manage",
      "audit.view",
      "audit.manage",
    ],
  },
  {
    key: "gp",
    name: "General practitioner",
    description:
      "General practice consultations and clinical notes. Prescribing is not yet available.",
    clinical_scope: "general",
    permissions: [
      "registry.view",
      "registry.create",
      "records.view",
      "profile.edit",
      "notes.create",
      "notes.edit",
      "notes.sign",
      "notes.amend",
      "audit.view",
    ],
  },
  {
    key: "nurse",
    name: "Nurse / midwife",
    description: "Nursing and midwifery assessments and care notes.",
    clinical_scope: "nursing",
    permissions: [
      "registry.view",
      "registry.create",
      "records.view",
      "profile.edit",
      "notes.create",
      "notes.edit",
      "notes.sign",
      "notes.amend",
      "audit.view",
    ],
  },
  {
    key: "pharmacist",
    name: "Pharmacist",
    description:
      "Medication review notes. Dispensing and prescribing modules are not yet available.",
    clinical_scope: "medication",
    permissions: [
      "registry.view",
      "records.view",
      "notes.create",
      "notes.edit",
      "notes.sign",
      "notes.amend",
      "audit.view",
    ],
  },
  {
    key: "pharmacy-technician",
    name: "Pharmacy technician",
    description: "Patient registry only. Stock and dispensing workflows are not yet available.",
    clinical_scope: null,
    permissions: ["registry.view"],
  },
  {
    key: "reception",
    name: "Receptionist",
    description: "Patient registration and registry; no clinical records.",
    clinical_scope: null,
    permissions: ["registry.view", "registry.create", "audit.view"],
  },
  {
    key: "accountant",
    name: "Accountant",
    description: "Job title only until finance tools are available.",
    clinical_scope: null,
    permissions: [],
  },
  {
    key: "cashier",
    name: "Cashier",
    description: "Job title only until payment tools are available.",
    clinical_scope: null,
    permissions: [],
  },
  {
    key: "business-developer",
    name: "Business developer",
    description: "Job title only until aggregate business reporting is available.",
    clinical_scope: null,
    permissions: [],
  },
  {
    key: "it",
    name: "IT",
    description: "Facility job title only; no automatic support or patient access.",
    clinical_scope: null,
    permissions: [],
  },
  {
    key: "zed-support",
    name: "Zed Tech support",
    description:
      "Verified Zed Tech personnel only. Facility-approved, time-limited workspace information access.",
    clinical_scope: null,
    permissions: ["workspace.view"],
  },
  {
    key: "clinician",
    name: "Clinical care professional (legacy)",
    description: "Existing general clinical access retained pending role review.",
    clinical_scope: "general",
    permissions: [
      "registry.view",
      "registry.create",
      "records.view",
      "profile.edit",
      "notes.create",
      "notes.edit",
      "notes.sign",
      "notes.amend",
      "audit.view",
    ],
  },
];
roleTemplates.push({
  ...roleTemplates.find((r) => r.key === "gp"),
  key: "consultant",
  name: "Consultant",
  description:
    "Reviewed medical consultant; specialist consultation and consultant referral responses.",
  permissions: [...roleTemplates.find((r) => r.key === "gp").permissions, "referrals.respond"],
});
for (const role of roleTemplates) {
  if (["gp", "nurse", "pharmacist", "clinician", "consultant"].includes(role.key))
    role.permissions.push("careteam.view", "admissions.view");
  if (["gp", "clinician"].includes(role.key)) role.permissions.push("referrals.create");
  if (["gp", "nurse", "pharmacist", "clinician", "consultant", "reception"].includes(role.key)) {
    role.permissions.push("visits.view");
    if (role.permissions.includes("registry.create")) role.permissions.push("visits.manage");
    if (role.permissions.includes("notes.create")) {
      role.permissions.push("visits.document", "followups.manage");
      if (["general", "nursing"].includes(role.clinical_scope))
        role.permissions.push("observations.create");
    }
  }
}
export async function upgradeVisitRoles(tx) {
  const existing = await tx.all(
    "SELECT id,template_key,clinical_scope,permissions FROM workspace_roles",
  );
  for (const role of existing) {
    if (
      !["gp", "nurse", "pharmacist", "clinician", "consultant", "reception"].includes(
        role.template_key,
      )
    )
      continue;
    const permissions = new Set(JSON.parse(role.permissions));
    if (permissions.has("registry.view")) permissions.add("visits.view");
    if (permissions.has("registry.create")) permissions.add("visits.manage");
    if (permissions.has("records.view") && permissions.has("notes.create")) {
      permissions.add("visits.document");
      permissions.add("followups.manage");
      if (["general", "nursing"].includes(role.clinical_scope))
        permissions.add("observations.create");
    }
    await tx.run("UPDATE workspace_roles SET permissions=? WHERE id=?", [
      JSON.stringify([...permissions]),
      role.id,
    ]);
  }
}
export const clinicalPermissions = new Set(
  permissionCatalog.filter((p) => p.category === "clinical").map((p) => p.key),
);
export const ownerPermissions = roleTemplates.find((r) => r.key === "administrator").permissions;
export async function createDefaultRoles(tx, organization) {
  for (const role of roleTemplates)
    await tx.run(
      "INSERT INTO workspace_roles(id,organization_id,name,description,template_key,clinical_scope,permissions) VALUES (?,?,?,?,?,?,?)",
      [
        "role-" + organization + "-" + role.key,
        organization,
        role.name,
        role.description,
        role.key,
        role.clinical_scope,
        JSON.stringify(role.permissions),
      ],
    );
}
export const permissionDependencies = {
  "careteam.view": "registry.view",
  "registry.create": "registry.view",
  "visits.view": "registry.view",
  "visits.manage": "visits.view",
  "records.view": "registry.view",
  "visits.document": "records.view",
  "observations.create": "records.view",
  "followups.manage": "records.view",
  "profile.edit": "records.view",
  "notes.create": "records.view",
  "notes.edit": "records.view",
  "notes.sign": "records.view",
  "notes.amend": "records.view",
  "referrals.create": "records.view",
  "referrals.respond": "records.view",
  "audit.manage": "audit.view",
  "roles.manage": "workspace.view",
  "staff.manage": "workspace.view",
  "branches.manage": "workspace.view",
  "areas.manage": "workspace.view",
};
export async function resolveMembership(tx, membership, user) {
  const roles = await tx.all(
    "SELECT r.* FROM membership_roles mr JOIN workspace_roles r ON r.id=mr.role_id WHERE mr.membership_id=? AND r.organization_id=? AND r.active=1 ORDER BY r.name",
    [membership.id, user.organization_id],
  );
  const approvedScopes = JSON.parse(membership.clinical_scopes || "[]");
  const scopes = roles
    .filter(
      (r) =>
        membership.clinical_verified && user.verified && approvedScopes.includes(r.clinical_scope),
    )
    .map((r) => r.clinical_scope)
    .filter(Boolean);
  const support = roles.some((r) => r.template_key === "zed-support");
  const expired =
    membership.access_expires_at && Date.parse(membership.access_expires_at) <= Date.now();
  const permissions = new Set(membership.is_owner ? ownerPermissions : []);
  for (const role of roles)
    for (const key of JSON.parse(role.permissions)) {
      if (!clinicalPermissions.has(key) || scopes.includes(role.clinical_scope))
        permissions.add(key);
    }
  if (support) {
    permissions.clear();
    if (user.provider_support_verified && membership.access_expires_at && !expired)
      permissions.add("workspace.view");
  }
  const denied = new Set(JSON.parse(membership.denied_permissions || "[]"));
  for (const key of denied) permissions.delete(key);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [key, required] of Object.entries(permissionDependencies))
      if (permissions.has(key) && !permissions.has(required)) {
        permissions.delete(key);
        changed = true;
      }
  }
  if (!membership.consultant_verified) permissions.delete("referrals.respond");
  user.consultantVerified = !!membership.consultant_verified;
  user.deniedPermissions = [...denied];
  user.careAreaRestricted = !!membership.care_area_restricted;
  const areaIds = JSON.parse(membership.care_area_ids || "[]");
  user.careAreaIds = areaIds.length
    ? (
        await tx.all(
          `SELECT id FROM care_areas WHERE organization_id=? AND active=1 AND id IN (${areaIds.map(() => "?").join(",")}) AND (CAST(? AS TEXT) IS NULL OR branch_id=?)`,
          [
            user.organization_id,
            ...areaIds,
            membership.branch_id ?? null,
            membership.branch_id ?? null,
          ],
        )
      ).map((a) => a.id)
    : [];
  user.permissions = !membership.active || expired ? [] : [...permissions];
  user.jobRoles = roles.map((r) => ({ id: r.id, name: r.name, clinical_scope: r.clinical_scope }));
  user.clinicalScopes = support || expired ? [] : [...new Set(scopes)];
  user.isOwner = !!membership.is_owner;
  user.accessExpired = !!expired;
  user.supportAccess = support;
  user.accessExpiresAt = membership.access_expires_at;
}
export function hasPermission(actor, key) {
  return actor?.permissions?.includes(key) ?? false;
}

export async function upgradePrimaryRoles(tx) {
  for (const row of await tx.all(
    "SELECT id,permissions FROM workspace_roles WHERE template_key='administrator'",
  )) {
    const permissions = JSON.parse(row.permissions);
    if (!permissions.includes("primary.manage"))
      await tx.run("UPDATE workspace_roles SET permissions=? WHERE id=?", [
        JSON.stringify([...permissions, "primary.manage"]),
        row.id,
      ]);
  }
}

export async function upgradeCareResponsibilities(tx) {
  for (const r of await tx.all("SELECT id,template_key,permissions FROM workspace_roles")) {
    const permission =
      r.template_key === "administrator"
        ? "careteam.manage"
        : ["gp", "nurse", "pharmacist", "clinician", "consultant"].includes(r.template_key)
          ? "careteam.view"
          : null;
    const permissions = JSON.parse(r.permissions);
    if (permission && !permissions.includes(permission))
      await tx.run("UPDATE workspace_roles SET permissions=? WHERE id=?", [
        JSON.stringify([...permissions, permission]),
        r.id,
      ]);
  }
}

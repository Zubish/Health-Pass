export const permissionCatalog = [
  { key: "registry.view", label: "View patient registry", category: "operational" },
  { key: "registry.create", label: "Register patients", category: "operational" },
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

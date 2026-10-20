export type JobRole = {
  id: string;
  name: string;
  description: string;
  template_key: string | null;
  clinical_scope: string | null;
  permissions: string[];
  active: number;
};
export type Permission = { key: string; label: string; category: string };
export type RoleTemplate = {
  key: string;
  name: string;
  description: string;
  clinical_scope: string | null;
  permissions: string[];
};
export const scopeNames: Record<string, string> = {
  general: "General practice",
  nursing: "Nursing / midwifery",
  medication: "Medication review",
  laboratory: "Laboratory",
  radiology: "Radiology",
};

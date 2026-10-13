export type Me = {
  securityAlerts?: number;
  user: { id: string; name: string; email: string; patient_id: string | null };
  role: string;
  permissions?: string[];
  deniedPermissions?: string[];
  careAreaRestricted?: boolean;
  careAreaIds?: string[];
  jobRoles?: { id: string; name: string; clinical_scope: string | null }[];
  clinicalScopes?: string[];
  isOwner?: boolean;
  accessExpired?: boolean;
  supportAccess?: boolean;
  accessExpiresAt?: string | null;
  organization: { id: string; name: string; workspace_code?: string } | null;
  pendingMembership?: boolean;
  branch?: { id: string; name: string } | null;
  mfaRequired: boolean;
  mfaEnrolled: boolean;
};
export type Patient = {
  can_activate?: boolean;
  id: string;
  healthpass_id: string;
  name: string;
  dob: string | null;
  phone?: string;
  allergy_status?: string;
  allergies?: string;
  emergency_contact?: string;
};
export type AccessScope = {
  restricted: boolean;
  scopes: string[];
  includeProfile: boolean;
  canContribute: boolean;
  canEditProfile?: boolean;
  contributionScopes: string[];
};
export type Note = {
  complaint: string;
  history: string;
  findings: string;
  assessment: string;
  plan: string;
};
export type Encounter = Note & {
  id: string;
  visit_id?: string | null;
  note_kind?: string;
  version: number;
  status: string;
  organization_name: string;
  author_name: string;
  created_at: string;
  editable: boolean;
  versions: {
    id: string;
    version: number;
    payload: Note;
    signed_at: string;
    signer_name: string;
    amendment_reason: string | null;
    signature_hash: string;
  }[];
};
export const blank: Note = { complaint: "", history: "", findings: "", assessment: "", plan: "" };
export const date = (value: string) =>
  new Date(value).toLocaleString("en-NG", {
    timeZone: "Africa/Lagos",
    dateStyle: "medium",
    timeStyle: "short",
  });

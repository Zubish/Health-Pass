export type AccessScope = "general" | "nursing" | "medication";
export type ProfessionalGrant = {
  id: string;
  parent_id: string | null;
  recipient_user_id: string;
  recipient_organization_id: string;
  recipient_name: string;
  facility_name: string;
  branch_name?: string | null;
  grantor_id?: string;
  can_delegate?: boolean;
  can_revoke?: boolean;
  effective?: boolean;
  grantor_name?: string;
  scopes: AccessScope[];
  include_profile: boolean;
  can_contribute: boolean;
  allow_delegation: boolean;
  allow_external_delegation: boolean;
  purpose: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  status: string;
};
export type ProfessionalAccessState = { restricted: boolean; grants: ProfessionalGrant[] };
export type ProfessionalOptions = {
  facility: { id: string; name: string };
  professionals: {
    id: string;
    name: string;
    branch_id: string | null;
    branch_name: string | null;
    clinicalScopes: string[];
  }[];
};

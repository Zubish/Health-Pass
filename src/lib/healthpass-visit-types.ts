export type CareVisit = {
  id: string;
  patient_id: string;
  patient_name: string;
  healthpass_id: string;
  branch_id: string;
  branch_name: string;
  assigned_user_id: string | null;
  assigned_name: string | null;
  status: "waiting" | "in-progress" | "completed" | "cancelled";
  version: number;
  checked_in_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  pending_handoff_id?: string | null;
  pending_handoff_to_user_id?: string | null;
  pending_handoff_to_name?: string | null;
  pending_handoff_expires_at?: string | null;
};
export type VisitObservation = {
  id: string;
  observations?: string;
  values: Record<string, number>;
  observed_at: string;
  author_name?: string;
};
export type VisitFollowUp = {
  updated_at?: string;
  resolution_reason?: string;
  id: string;
  author_id?: string;
  author_name?: string;
  discipline?: string;
  title: string;
  due_at: string;
  status: string;
  version: number;
  created_at?: string;
};
export type VisitDetail = {
  visit: CareVisit;
  clinicalAllowed: boolean;
  canDocument?: boolean;
  accessScope?: import("./healthpass-types").AccessScope;
  observations: VisitObservation[];
  followUps: VisitFollowUp[];
};

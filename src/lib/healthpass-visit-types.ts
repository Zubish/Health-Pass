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
};
export type VisitObservation = {
  id: string;
  values: Record<string, number>;
  observed_at: string;
  author_name?: string;
};
export type VisitFollowUp = {
  id: string;
  title: string;
  due_at: string;
  status: string;
  version: number;
  created_at?: string;
};
export type VisitDetail = {
  visit: CareVisit;
  clinicalAllowed: boolean;
  observations: VisitObservation[];
  followUps: VisitFollowUp[];
};

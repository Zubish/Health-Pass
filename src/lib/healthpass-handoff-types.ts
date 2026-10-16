export type VisitHandoffEntry = {
  id: string;
  visit_id: string;
  from_user_id: string;
  to_user_id: string;
  from_name: string;
  to_name: string;
  source_encounter_id: string;
  source_version: number;
  source_note_kind: string;
  status: "pending" | "accepted" | "declined" | "cancelled";
  pending_live: boolean;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  version: number;
  can_accept: boolean;
  can_decline: boolean;
  can_withdraw: boolean;
  unavailable_reason: string | null;
};
export type VisitHandoffState = {
  handoffs: VisitHandoffEntry[];
  canRequest: boolean;
  canAccept: boolean;
  canWithdraw: boolean;
  sourceNotes: { id: string; version: number; note_kind: string; created_at: string }[];
  professionals: {
    id: string;
    name: string;
    clinicalScopes: string[];
    allowed_source_note_ids?: string[];
  }[];
};

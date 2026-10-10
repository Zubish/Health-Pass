export interface Session {
  user: { id: string; name: string; role: string; organizationId: string; patientId?: string };
  csrfToken: string;
}
export interface Patient {
  id: string;
  name: string;
  healthPassId: string;
}
export interface Encounter {
  id: string;
  patientId: string;
  note: string;
  status: string;
  version: number;
}
export interface Item {
  id: string;
  name: string;
  form: string;
  strength: string;
  dose: number;
  doseUnit: string;
  route: string;
  frequency: string;
  duration: string;
  quantity: number;
  dispensingUnit: string;
  instructions: string;
  substitutionPolicy: string;
}
export interface Prescription {
  prescriptionId: string;
  patientId: string;
  encounterId: string;
  version: number;
  validUntil: string;
  items: Item[];
  orderStatus: "draft" | "active" | "cancelled";
  transport: string;
  review: string;
  fulfilment: string;
  events: { eventId: string; eventType: string; occurredAt: string }[];
  dispensed: Record<string, number>;
}
export interface Consent {
  id: string;
  patientId: string;
  purpose: string;
  expiresAt: string;
  revokedAt?: string;
}
export interface Audit {
  id: string;
  action: string;
  createdAt?: string;
  occurredAt?: string;
}
export interface Workspace {
  patients: Patient[];
  encounters: Encounter[];
  prescriptions: Prescription[];
  consents: Consent[];
  audit: Audit[];
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as { error?: string | { message?: string }; message?: string } | null;
    throw new ApiError(
      typeof error?.error === "string"
        ? error.error
        : error?.message ||
            (typeof error?.error === "object" ? error.error?.message : undefined) ||
            `Request failed (${response.status}).`,
      response.status,
    );
  }
  return data as T;
}

export interface Analytics {
  metrics: {
    prescription_count: number;
    dispatched_prescription_count: number;
    acknowledged_prescription_count: number;
    partially_dispensed_prescription_count: number;
    dispensed_prescription_count: number;
    cancelled_prescription_count: number;
    pending_item_count: number;
  };
  explanation: string | null;
  explanation_status: string;
  scope: { date_range: { start_date: string; end_date: string } };
}

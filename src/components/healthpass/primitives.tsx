import type { ReactNode } from "react";
import { FileHeart, ChevronRight, X } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import type { Patient } from "@/lib/healthpass-types";
export function Mark() {
  return (
    <span className="hp-mark">
      <FileHeart size={22} />
    </span>
  );
}
export function Stat({
  icon,
  tone,
  value,
  label,
  detail,
}: {
  icon: ReactNode;
  tone: string;
  value: string;
  label: string;
  detail: string;
}) {
  return (
    <section className="hp-stat">
      <span className={`hp-icon-tile ${tone}`}>{icon}</span>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </section>
  );
}
export function PatientRow({ patient, onClick }: { patient: Patient; onClick?: () => void }) {
  const content = (
    <>
      <span className="hp-avatar teal">
        {patient.name
          .split(" ")
          .slice(0, 2)
          .map((n) => n[0])
          .join("")}
      </span>
      <span className="hp-patient-name">
        <strong>{patient.name}</strong>
        <small>
          {patient.healthpass_id} <span>·</span> {patient.dob || "DOB unknown"}
        </small>
      </span>
      <span className="hp-chip neutral">Registered</span>
      {onClick && <ChevronRight size={18} />}
    </>
  );
  return onClick ? (
    <button className="hp-patient-row" onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className="hp-patient-row">{content}</div>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="hp-empty">
      <FileHeart size={28} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="hp-modal-overlay" />
        <Dialog.Content
          className="hp-modal hp-dialog-content hp-shell"
          aria-describedby={undefined}
        >
          <div className="hp-panel-heading">
            <Dialog.Title asChild>
              <h2>{title}</h2>
            </Dialog.Title>
            <Dialog.Close className="hp-close" aria-label="Close dialog">
              <X />
            </Dialog.Close>
          </div>
          <div className="hp-padded">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

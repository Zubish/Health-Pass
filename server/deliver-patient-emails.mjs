import { openDatabase } from "./db.mjs";
import { deliverPatientEmails, emailReady } from "./patient-email.mjs";
if (!emailReady(process.env))
  throw new Error(
    "Configure RESEND_API_KEY, HEALTHPASS_EMAIL_FROM and HEALTHPASS_AUTH_KEY before sending patient invitations.",
  );
const db = await openDatabase(process.env);
try {
  for (let i = 0; i < 20; i++) await deliverPatientEmails(db, process.env);
} finally {
  await db.close();
}
console.log("Patient invitation queue processed; check delivery status in the facility registry.");

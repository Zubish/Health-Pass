import { revealSecret } from "./security.mjs";
export const emailReady = (config) =>
  !!(config.RESEND_API_KEY && config.HEALTHPASS_EMAIL_FROM && config.HEALTHPASS_AUTH_KEY);
// Delivery happens after commit. A leased durable outbox survives provider failure and process restarts.
export async function deliverPatientEmails(db, config, send = globalThis.fetch) {
  if (!emailReady(config)) return;
  const now = new Date().toISOString();
  const item = await db.transaction(async (tx) => {
    const row = await tx.get(
      `SELECT o.* FROM patient_email_outbox o JOIN patient_claims c ON c.id=o.id WHERE o.sent_at IS NULL AND c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.expires_at>? AND o.attempts<8 AND (o.retry_after IS NULL OR o.retry_after<=?) AND (o.lease_until IS NULL OR o.lease_until<=?) ORDER BY o.created_at,o.id LIMIT 1`,
      [now, now, now],
    );
    if (!row) return null;
    return await tx.get(
      `UPDATE patient_email_outbox SET lease_until=?,attempts=attempts+1 WHERE id=? AND sent_at IS NULL AND (lease_until IS NULL OR lease_until<=?) RETURNING *`,
      [new Date(Date.now() + 60000).toISOString(), row.id, now],
    );
  });
  if (!item) return;
  let error = null;
  try {
    const message = JSON.parse(revealSecret(item.encrypted_payload, config.HEALTHPASS_AUTH_KEY));
    const response = await send("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `hp-patient-claim-${item.id}`,
      },
      body: JSON.stringify({
        from: config.HEALTHPASS_EMAIL_FROM,
        to: [message.email],
        subject: `${message.facility} has registered you on HealthPass`,
        text: `Dear patient,\n\n${message.facility} has registered you as a patient on HealthPass. Verify your email and create a password to view your care records and manage who can access them.\n\nVerify email and create account:\n${message.url}\n\nThis link expires in 24 hours and can be used once. If you did not attend this facility, do not activate the account; contact HealthPass support. No clinical information is included in this email.`,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) error = `provider_${response.status}`;
  } catch {
    error = "delivery_unavailable";
  }
  await db.transaction((tx) =>
    tx.run(
      `UPDATE patient_email_outbox SET sent_at=?,lease_until=NULL,retry_after=?,last_error=? WHERE id=?`,
      [
        error ? null : new Date().toISOString(),
        error
          ? new Date(Date.now() + Math.min(item.attempts * 60000, 3600000)).toISOString()
          : null,
        error,
        item.id,
      ],
    ),
  );
}

/** Select released clinical facts explicitly; never return drafts or internal request payloads. */
export async function emergencySummaries(tx, patientId, scopes) {
  const summaries = [];
  const entry = (row, title, recordedAt, fields) =>
    summaries.push({
      id: row.id,
      title,
      author_name: row.author_name,
      facility_name: row.facility_name,
      recorded_at: recordedAt,
      fields: fields
        .filter(([, value]) => value !== null && value !== undefined && value !== "")
        .map(([label, value]) => ({ label, value: String(value) })),
    });
  if (scopes.includes("medication")) {
    const orders = await tx.all(
      "SELECT m.*,u.name AS author_name,o.name AS facility_name FROM medication_orders m JOIN users u ON u.id=m.prescriber_id JOIN organizations o ON o.id=m.organization_id WHERE m.patient_id=? ORDER BY m.created_at DESC",
      [patientId],
    );
    for (const row of orders) {
      entry(row, "Prescription", row.created_at, [
        ["Medicine", row.medicine],
        ["Dose", row.dose],
        ["Route", row.route],
        ["Frequency", row.frequency],
        ["Indication", row.indication],
        ["Instructions", row.instructions],
        ["Starts", row.starts_at],
        ["Ends", row.ends_at],
        ["Status", row.status],
        ["Stopped", row.stopped_at],
        ["Stop reason", row.stop_reason],
      ]);
      const administrations = await tx.all(
        "SELECT a.*,u.name AS author_name FROM medication_administrations a JOIN users u ON u.id=a.author_id WHERE a.order_id=? ORDER BY a.administered_at DESC",
        [row.id],
      );
      for (const a of administrations) {
        entry(
          { ...a, facility_name: row.facility_name },
          "Medication administration",
          a.administered_at,
          [
            ["Medicine", row.medicine],
            ["Outcome", a.outcome],
            ["Dose", a.dose],
            ["Reason", a.reason],
            ["Observations", a.observations],
          ],
        );
      }
    }
  }
  for (const department of ["laboratory", "radiology"]) {
    if (scopes.includes(department)) {
      const reports = await tx.all(
        "SELECT r.id,r.report,r.details,r.signed_at,r.amendment_reason,d.service,u.name AS author_name,o.name AS facility_name FROM department_orders d JOIN department_reports r ON r.order_id=d.id JOIN users u ON u.id=r.author_id JOIN organizations o ON o.id=d.organization_id WHERE d.patient_id=? AND d.department=? AND d.status='released' ORDER BY r.signed_at DESC",
        [patientId, department],
      );
      for (const r of reports) {
        entry(
          r,
          department === "laboratory" ? "Released laboratory report" : "Released imaging report",
          r.signed_at,
          [
            ["Test / examination", r.service],
            ["Report", r.report],
            ["Method / reference", JSON.parse(r.details).method],
            ["Critical result", JSON.parse(r.details).critical ? "Yes" : "No"],
            ["Critical result communication", JSON.parse(r.details).critical_communication],
            ["Amendment reason", r.amendment_reason],
          ],
        );
      }
    }
  }
  if (scopes.some((s) => ["general", "nursing"].includes(s))) {
    const ward = await tx.all(
      "SELECT w.id,w.discipline,w.values_json,w.observations,w.observed_at,u.name AS author_name,o.name AS facility_name FROM ward_observations w JOIN users u ON u.id=w.author_id JOIN organizations o ON o.id=w.organization_id WHERE w.patient_id=?",
      [patientId],
    );
    const visits = await tx.all(
      "SELECT w.id,w.discipline,w.values_json,w.observations,w.observed_at,u.name AS author_name,o.name AS facility_name FROM visit_observations w JOIN care_visits v ON v.id=w.visit_id JOIN users u ON u.id=w.author_id JOIN organizations o ON o.id=v.organization_id WHERE v.patient_id=?",
      [patientId],
    );
    for (const row of [...ward, ...visits].filter((r) => scopes.includes(r.discipline))) {
      entry(row, "Observations and vital signs", row.observed_at, [
        ...Object.entries(JSON.parse(row.values_json)).map(([key, value]) => [
          key.replaceAll("_", " "),
          value,
        ]),
        ["Observations", row.observations],
      ]);
    }
  }
  if (scopes.includes("general")) {
    const decisions = await tx.all(
      "SELECT d.*,u.name AS author_name,o.name AS facility_name FROM clinical_admission_decisions d JOIN users u ON u.id=d.physician_id JOIN organizations o ON o.id=d.organization_id WHERE d.patient_id=?",
      [patientId],
    );
    for (const row of decisions) {
      entry(
        row,
        row.kind === "admit" ? "Admission decision" : "Discharge decision",
        row.decided_at,
        [
          ["Reason", row.reason],
          ["Observations", row.observations],
        ],
      );
    }
  }
  return summaries.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
}

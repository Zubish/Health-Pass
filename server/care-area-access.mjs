// A location label is never clinical authority. Unknown locations fail closed for restricted staff.
export function careAreaPatientPredicate(actor, patientExpression = "p.id") {
  if (!actor.careAreaRestricted) return { sql: "1=1", args: [] };
  const ids = actor.careAreaIds ?? [];
  if (!ids.length) return { sql: "1=0", args: [] };
  const marks = ids.map(() => "?").join(",");
  return {
    sql: `(EXISTS(SELECT 1 FROM care_admissions ca WHERE ca.patient_id=${patientExpression} AND ca.organization_id=? AND ca.status='active' AND ca.care_area_id IN (${marks})) OR (NOT EXISTS(SELECT 1 FROM care_admissions ca WHERE ca.patient_id=${patientExpression} AND ca.organization_id=? AND ca.status='active') AND EXISTS(SELECT 1 FROM care_visits cv WHERE cv.patient_id=${patientExpression} AND cv.organization_id=? AND cv.status IN ('waiting','in-progress') AND cv.care_area_id IN (${marks}))))`,
    args: [actor.organization_id, ...ids, actor.organization_id, actor.organization_id, ...ids],
  };
}
export async function careAreaAllowsPatient(tx, actor, patientId) {
  const predicate = careAreaPatientPredicate(actor);
  return !!(await tx.get(`SELECT p.id FROM patients p WHERE p.id=? AND (${predicate.sql})`, [
    patientId,
    ...predicate.args,
  ]));
}
export function careAreaAllows(actor, areaId) {
  return !actor.careAreaRestricted || (actor.careAreaIds ?? []).includes(areaId);
}

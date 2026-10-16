/** Database guards complement API checks; runtime credentials cannot rewrite event history. */
export function proxyGuards(engine) {
  const rules = [
    ["proxy_events", null],
    ["patient_proxies", ["status", "decided_at"]],
    [
      "emergency_requests",
      ["status", "decided_by", "decision_reason", "decided_at", "access_until"],
    ],
  ];
  const columns = {
    patient_proxies: [
      "id",
      "patient_id",
      "proxy_user_id",
      "proxy_organization_id",
      "scopes_json",
      "include_profile",
      "policy_version",
      "consented_at",
      "created_at",
    ],
    emergency_requests: [
      "id",
      "appointment_id",
      "patient_id",
      "requester_id",
      "organization_id",
      "branch_id",
      "scopes_json",
      "include_profile",
      "reason",
      "created_at",
      "expires_at",
    ],
  };
  return rules.flatMap(([table, mutable]) => {
    if (engine === "sqlite") {
      return [
        `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Emergency history cannot be deleted'); END`,
        `CREATE TRIGGER ${table}_no_rewrite BEFORE UPDATE ON ${table}${mutable ? " WHEN " + columns[table].map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ") : ""} BEGIN SELECT RAISE(ABORT,'Emergency evidence cannot be rewritten'); END`,
      ];
    }
    const condition = mutable
      ? `(to_jsonb(NEW)${mutable.map((c) => `-'${c}'`).join("")}) IS DISTINCT FROM (to_jsonb(OLD)${mutable.map((c) => `-'${c}'`).join("")})`
      : "TRUE";
    return [
      `CREATE FUNCTION hp_${table}_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Emergency history cannot be deleted'; END IF; IF ${condition} THEN RAISE EXCEPTION 'Emergency evidence cannot be rewritten'; END IF; RETURN NEW; END $$`,
      `CREATE TRIGGER ${table}_guard BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION hp_${table}_guard()`,
    ];
  });
}

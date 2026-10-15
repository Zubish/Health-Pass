import { permissionCatalog } from "./roles.mjs";
/** Setup is guidance only: it never grants access, consent, or clinical authority. */
export async function handleAccountSetup(tx, context) {
  const { path, method, actor, body, fail, strong } = context;
  if (path !== "/account/setup") {
    return;
  }
  if (!actor) {
    fail(401, "Sign in to continue.");
  }
  if (!actor.pendingMembership) {
    strong(actor);
  }
  const scope = actor.organization_id || "patient";
  if (method === "POST") {
    // Serialize devices editing the same guide before reading its review/dismissal state.
    await tx.run(
      "INSERT INTO account_setup(user_id,scope) VALUES (?,?) ON CONFLICT(user_id,scope) DO NOTHING",
      [actor.id, scope],
    );
    await tx.run("UPDATE account_setup SET dismissed=dismissed WHERE user_id=? AND scope=?", [
      actor.id,
      scope,
    ]);
  }

  const previous = await tx.get("SELECT * FROM account_setup WHERE user_id=? AND scope=?", [
    actor.id,
    scope,
  ]);
  const reviewed = new Set(JSON.parse(previous?.reviewed || "[]"));
  const steps = [];
  const review = (id, title, description, tab) =>
    steps.push({
      id,
      title,
      description,
      tab,
      reviewable: true,
      status: reviewed.has(id) ? "done" : "todo",
    });
  const can = (key) => actor.permissions?.includes(key);
  const pending = !!actor.pendingMembership;
  const phase = pending ? "pending" : "active";
  const samePhase = previous?.presented_phase === phase;
  const patient = actor.role === "patient";
  if (!pending) {
    if (patient) {
      review(
        "profile",
        "Review your personal details",
        "Check your record details. Ask your care facility to correct anything inaccurate.",
        "patients",
      );
      const primary = await tx.get("SELECT organization_id FROM primary_care WHERE patient_id=?", [
        actor.patient_id,
      ]);
      const request = await tx.get(
        "SELECT id FROM primary_care_requests WHERE patient_id=? AND status='pending' AND expires_at>?",
        [actor.patient_id, new Date().toISOString()],
      );
      steps.push({
        id: "primary",
        title: "Choose your primary care facility",
        description:
          "Your first registering facility can be primary automatically. Other facilities must accept your request. This does not share your entire record.",
        tab: "relationships",
        reviewable: false,
        status: primary?.organization_id ? "done" : request ? "pending" : "todo",
      });
      review(
        "proxies",
        "Choose your emergency proxy",
        "Invite an existing HealthPass user or your primary care facility. Read the emergency-sharing policy and choose their authority.",
        "proxies",
      );
      review(
        "sharing",
        "Review who can see your records",
        "Choose facilities, professionals and the information you share. Keeping your records private is a valid choice.",
        "sharing",
      );
    } else {
      review(
        "workspace",
        "Confirm your workspace and access",
        "Review the facility, branch and assigned roles below. Contact your administrator if anything is incorrect.",
        null,
      );
      if ((actor.isOwner || actor.role === "administrator") && can("roles.manage")) {
        const logo = await tx.get(
          "SELECT organization_id FROM workspace_logos WHERE organization_id=?",
          [actor.organization_id],
        );
        steps.push({
          id: "logo",
          title: "Add your facility logo",
          description:
            "Help your team recognise the correct workspace. Upload an image or keep the initials placeholder.",
          tab: "security",
          reviewable: true,
          status: logo || reviewed.has("logo") ? "done" : "todo",
        });
      }
      if (can("workspace.view")) {
        if (can("branches.manage")) {
          review(
            "branches",
            "Review facility details and branches",
            "Check the facility sign-in link and configure the branches your team uses.",
            "workspace",
          );
        }
        if (can("areas.manage")) {
          review(
            "areas",
            "Set up your departments and wards",
            "Add the care areas your facility actually operates.",
            "workspace",
          );
        }
        if (can("roles.manage")) {
          review(
            "roles",
            "Review job roles and permissions",
            "Adapt role defaults to real duties before assigning professionals.",
            "workspace",
          );
        }
        if (can("staff.manage")) {
          review(
            "team",
            "Prepare your care team",
            "Share your workspace code and review professional access requests.",
            "workspace",
          );
        }
      }
      if (
        [
          "diagnostics.order",
          "prescriptions.create",
          "laboratory.work",
          "radiology.work",
          "pharmacy.review",
        ].some(can)
      ) {
        review(
          "department",
          "Find your department’s work",
          "Open the worklist available under your assigned permissions.",
          "departments",
        );
      } else if (can("visits.view")) {
        review(
          "daily",
          "Find your daily work",
          "See visits and the work assigned to your team.",
          "today",
        );
      }
    }
    review(
      "security",
      "Review session security",
      "Understand the 30-minute inactivity timeout and 30-day expiry, and choose your optional eight-hour limit.",
      "security",
    );
  }
  review(
    "preferences",
    "Choose your appearance and sound",
    "Choose light, dark or device appearance and whether completion sounds play.",
    "security",
  );
  if (method === "POST") {
    if (!["later", "dismiss", "review", "presented"].includes(body.action)) {
      fail(400, "Choose a setup action.");
    }
    if (body.action === "review") {
      if (!steps.some((step) => step.id === body.step && step.reviewable)) {
        fail(400, "This setup step cannot be marked reviewed.");
      }
      reviewed.add(body.step);
    }
    const dismissed = body.action === "dismiss" ? 1 : previous?.dismissed || 0;
    const until =
      body.action === "later"
        ? new Date(Date.now() + 7 * 86400000).toISOString()
        : body.action === "presented"
          ? null
          : previous?.snoozed_until || null;
    const shown =
      body.action === "presented" ? new Date().toISOString() : previous?.presented_at || null;
    await tx.run(
      "INSERT INTO account_setup(user_id,scope,reviewed,dismissed,snoozed_until,presented_at,presented_phase) VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,scope) DO UPDATE SET reviewed=excluded.reviewed,dismissed=excluded.dismissed,snoozed_until=excluded.snoozed_until,presented_at=excluded.presented_at,presented_phase=excluded.presented_phase",
      [actor.id, scope, JSON.stringify([...reviewed]), dismissed, until, shown, phase],
    );
    return { saved: true };
  }
  if (method !== "GET") {
    fail(405, "Method not allowed.");
  }
  return {
    steps,
    access:
      pending || patient
        ? []
        : permissionCatalog
            .filter((permission) => can(permission.key))
            .map((permission) => permission.label),
    pending,
    patient,
    dismissed: !!previous?.dismissed,
    showAutomatically:
      !previous?.dismissed &&
      (!samePhase ||
        !previous?.snoozed_until ||
        previous.snoozed_until <= new Date().toISOString()) &&
      (!samePhase || !previous?.presented_at || !!previous?.snoozed_until) &&
      steps.some((step) => step.status === "todo"),
  };
}

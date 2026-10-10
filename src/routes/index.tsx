import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Building2,
  Check,
  ChevronDown,
  ClipboardList,
  FileHeart,
  History,
  LockKeyhole,
  Menu,
  Share2,
  ShieldCheck,
  X,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: Landing });
const register = "/workspace?mode=register";

function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = [
    { href: "#benefits", label: "Your record" },
    { href: "#how", label: "How sharing works" },
    { href: "#providers", label: "For care teams" },
    { href: "#faq", label: "Questions" },
  ];
  return (
    <div className="hp-landing" id="top">
      <a className="hp-landing-skip" href="#main">
        Skip to content
      </a>
      <header className="hp-landing-header">
        <div className="hp-landing-wrap hp-landing-nav">
          <a href="#top" className="hp-landing-brand" aria-label="HealthPass home">
            <span>
              <FileHeart size={21} aria-hidden="true" />
            </span>
            HealthPass
          </a>
          <nav className="hp-landing-desktop-nav" aria-label="Main navigation">
            {navigation.map((item) => (
              <a key={item.href} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="hp-landing-nav-actions">
            <a href="/workspace" className="hp-landing-signin">
              Sign in
            </a>
            <a className="hp-landing-button hp-landing-button-small" href={register}>
              Create account <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <button
              className="hp-landing-menu-button"
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
            >
              {menuOpen ? <X size={23} /> : <Menu size={23} />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-navigation"
            className="hp-landing-mobile-nav"
            aria-label="Mobile navigation"
          >
            {navigation.map((item) => (
              <a key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
                {item.label}
                <ArrowUpRight size={16} aria-hidden="true" />
              </a>
            ))}
          </nav>
        )}
      </header>
      <main id="main">
        <section className="hp-landing-hero hp-landing-wrap">
          <div className="hp-landing-hero-copy">
            <span className="hp-landing-eyebrow">
              <span /> A clearer picture of your care
            </span>
            <h1>
              Your care history,
              <br />
              <em>connected.</em>
            </h1>
            <p className="hp-landing-lead">
              Keep a clearer record of your care, view signed clinical notes, and choose when to
              share your history with another participating care team.
            </p>
            <div className="hp-landing-actions">
              <a className="hp-landing-button" href={register}>
                Create patient account <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a className="hp-landing-text-link" href="#how">
                Explore how it works <ArrowUpRight size={17} aria-hidden="true" />
              </a>
            </div>
            <div className="hp-landing-hero-points">
              <span>
                <Check size={16} />
                Signed visit history
              </span>
              <span>
                <Check size={16} />
                Time-limited sharing
              </span>
              <span>
                <Check size={16} />
                Access history
              </span>
            </div>
            <p className="hp-landing-availability">
              An early HealthPass experience. Availability depends on participating facilities.
            </p>
          </div>
          <RecordPreview />
        </section>
        <section className="hp-landing-principles" aria-label="Record principles">
          <div className="hp-landing-wrap">
            <span>
              <FileHeart size={19} />
              Care with context
            </span>
            <span>
              <Share2 size={19} />
              Sharing with a choice
            </span>
            <span>
              <History size={19} />
              Changes with a history
            </span>
          </div>
        </section>
        <section id="benefits" className="hp-landing-section hp-landing-wrap">
          <div className="hp-landing-section-heading">
            <div>
              <span className="hp-landing-eyebrow">Your record, less fragmented</span>
              <h2>
                Less starting over.
                <br />
                More context for your care.
              </h2>
            </div>
            <p>
              Good care starts with knowing what came before. HealthPass brings the record and the
              people who need it closer together.
            </p>
          </div>
          <div className="hp-landing-benefits">
            <article className="hp-landing-benefit">
              <span className="hp-landing-icon hp-landing-blue">
                <ClipboardList size={24} />
              </span>
              <span className="hp-landing-card-number">01 / YOUR HISTORY</span>
              <h3>A record you can revisit</h3>
              <p>
                See your signed clinical notes and retained visit history, with the care team and
                date alongside each entry.
              </p>
              <span className="hp-landing-detail">
                <Check size={15} />
                Clear source. Clear timeline.
              </span>
            </article>
            <article className="hp-landing-benefit">
              <span className="hp-landing-icon hp-landing-teal">
                <Share2 size={24} />
              </span>
              <span className="hp-landing-card-number">02 / YOUR CHOICE</span>
              <h3>Share with a time limit</h3>
              <p>
                Give a participating facility access to your signed history. Choose an expiry and
                revoke sharing when you need to.
              </p>
              <span className="hp-landing-detail">
                <Check size={15} />
                Permission you can review.
              </span>
            </article>
            <article className="hp-landing-benefit">
              <span className="hp-landing-icon hp-landing-burgundy">
                <History size={24} />
              </span>
              <span className="hp-landing-card-number">03 / YOUR CONTEXT</span>
              <h3>Keep the history of care</h3>
              <p>
                Signed notes retain their original version. Amendments add context, and your
                activity view helps you follow record access.
              </p>
              <span className="hp-landing-detail">
                <Check size={15} />
                Changes remain traceable.
              </span>
            </article>
          </div>
        </section>
        <section id="how" className="hp-landing-how">
          <div className="hp-landing-wrap hp-landing-how-grid">
            <div>
              <span className="hp-landing-eyebrow">Patient-controlled sharing</span>
              <h2>
                The right context.
                <br />
                For your next care team.
              </h2>
              <p className="hp-landing-section-copy">
                Your HealthPass identity doesn't open your history to every facility. Sharing is a
                deliberate choice with a defined scope and an expiry.
              </p>
              <a className="hp-landing-text-link" href={register}>
                Start with your account <ArrowRight size={17} />
              </a>
              <div className="hp-landing-sharing-note">
                <LockKeyhole size={20} />
                <p>
                  Shared history includes signed notes. Another facility cannot rewrite the source
                  facility's signed record.
                </p>
              </div>
            </div>
            <ol className="hp-landing-steps">
              <li>
                <span>01</span>
                <div>
                  <h3>Create your patient account</h3>
                  <p>
                    Sign up to access your own HealthPass workspace. Your account starts with your
                    identity, not a match based on a shared phone number.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Review your care history</h3>
                  <p>
                    View signed notes as participating care teams record visits. See where each
                    entry came from and when it was signed.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>Choose a facility to share with</h3>
                  <p>
                    Select a participating facility and set how long sharing lasts. Review active
                    permissions or revoke a grant from your workspace.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>
        <section id="providers" className="hp-landing-section hp-landing-wrap">
          <div className="hp-landing-provider">
            <div>
              <span className="hp-landing-eyebrow">For participating care teams</span>
              <h2>
                A better handover
                <br />
                starts with a better record.
              </h2>
              <p>
                Register patients, document encounters, and sign or amend clinical notes while
                preserving their history. Work with shared context when the patient grants access.
              </p>
              <a className="hp-landing-button hp-landing-button-light" href="/workspace">
                Professional sign in <ArrowRight size={18} />
              </a>
              <p className="hp-landing-provider-note">
                Professional access requires facility onboarding and verified membership. Patient
                signup doesn't create a clinician account.
              </p>
            </div>
            <div className="hp-landing-provider-features">
              {[
                {
                  icon: Building2,
                  title: "Facility-scoped access",
                  copy: "Roles and active membership define which workflows a team member can use.",
                },
                {
                  icon: ShieldCheck,
                  title: "An extra sign-in check",
                  copy: "Professional accounts use authenticator verification before accessing the care workspace.",
                },
                {
                  icon: History,
                  title: "A visible record of actions",
                  copy: "Clinical changes and allowed or denied access produce an audit trail.",
                },
              ].map(({ icon: Icon, title, copy }) => (
                <div key={title}>
                  <span>
                    <Icon size={22} />
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{copy}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="hp-landing-ecosystem hp-landing-wrap" aria-label="HealthPass ecosystem">
          <span className="hp-landing-eyebrow">A shared vision for connected care</span>
          <div>
            <h2>
              HealthPass is the care record.
              <br />
              <span>The ecosystem grows around it.</span>
            </h2>
            <p>
              RxLedger focuses on pharmacy operations. Rai is part of the wider care vision. Their
              HealthPass integrations are planned; prescription exchange and AI support aren't
              connected yet.
            </p>
          </div>
          <div className="hp-landing-ecosystem-names">
            <span>
              <FileHeart size={18} />
              HealthPass <small>Care record</small>
            </span>
            <span>
              RxLedger <small>Pharmacy operations</small>
            </span>
            <span>
              Rai <small>Planned care support</small>
            </span>
          </div>
        </section>
        <FAQ />
        <section className="hp-landing-final hp-landing-wrap">
          <span className="hp-landing-eyebrow">Start with a clearer record</span>
          <h2>
            Your next chapter of care,
            <br />
            with more context.
          </h2>
          <p>Create a patient account or sign in to your existing workspace.</p>
          <div className="hp-landing-actions">
            <a className="hp-landing-button" href={register}>
              Create patient account <ArrowRight size={18} />
            </a>
            <a className="hp-landing-text-link" href="/workspace">
              Already have an account? Sign in <ArrowUpRight size={16} />
            </a>
          </div>
        </section>
      </main>
      <footer className="hp-landing-footer">
        <div className="hp-landing-wrap">
          <div>
            <a href="#top" className="hp-landing-brand">
              <span>
                <FileHeart size={20} />
              </span>
              HealthPass
            </a>
            <p>Care history. Clearer connections.</p>
          </div>
          <nav aria-label="Footer navigation">
            <a href="#how">Sharing and access</a>
            <a href="#providers">Professional access</a>
            <a href="#faq">Questions</a>
            <a href="/workspace">Sign in</a>
          </nav>
          <span className="hp-landing-footer-note">
            HealthPass · An early care-record experience
          </span>
        </div>
      </footer>
    </div>
  );
}

function RecordPreview() {
  return (
    <div className="hp-landing-preview-scene">
      <div
        className="hp-landing-preview"
        aria-label="Illustrative HealthPass record using synthetic example data"
      >
        <div className="hp-landing-preview-header">
          <span>
            <FileHeart size={18} />
            HealthPass
          </span>
          <span className="hp-landing-example">Sample record</span>
        </div>
        <div className="hp-landing-record-person">
          <span className="hp-landing-avatar">AO</span>
          <div>
            <h2>Alex Okoro</h2>
            <p>Synthetic example · HP-DEMO-001</p>
          </div>
          <ShieldCheck size={22} />
        </div>
        <div className="hp-landing-preview-tabs">
          <span>Care history</span>
          <span>Sharing</span>
          <span>Activity</span>
        </div>
        <div className="hp-landing-record-summary">
          <div>
            <span>CARE HISTORY</span>
            <strong>Your visits, in view.</strong>
          </div>
          <span className="hp-landing-status">
            <span />
            Signed records
          </span>
        </div>
        <div className="hp-landing-record-entry">
          <span className="hp-landing-icon hp-landing-blue">
            <ClipboardList size={20} />
          </span>
          <div>
            <h3>Primary care review</h3>
            <p>Example Care Clinic · 8 October 2026</p>
            <span>
              Signed clinical note <Check size={12} />
            </span>
          </div>
          <ChevronDown size={17} />
        </div>
        <div className="hp-landing-record-context">
          <span>
            <ShieldCheck size={16} />
            Allergy context
          </span>
          <p>Reviewed, none known, or not yet recorded. Missing information stays unknown.</p>
        </div>
        <div className="hp-landing-record-sharing">
          <span className="hp-landing-icon hp-landing-teal">
            <Share2 size={19} />
          </span>
          <div>
            <h3>Sharing on your terms</h3>
            <p>Example Partner Clinic</p>
            <span>Access expires 15 October 2026</span>
          </div>
          <LockKeyhole size={17} />
        </div>
        <div className="hp-landing-preview-footer">
          <History size={15} />
          <span>View your record access history</span>
          <ArrowRight size={15} />
        </div>
      </div>
      <p className="hp-landing-preview-caption">
        Illustrative preview · synthetic data · no real facility affiliation
      </p>
      <div className="hp-landing-preview-label">
        <span />A little more context. A better next visit.
      </div>
    </div>
  );
}

function FAQ() {
  const questions = [
    {
      question: "Can every hospital see my record?",
      answer:
        "No. HealthPass works with participating facilities. Professional access depends on an active, verified facility membership and role. Sharing your signed history with another facility requires a grant from your patient workspace; it expires when you choose and can be revoked. Revoking sharing ends future shared access; it does not remove a facility's own care record.",
    },
    {
      question: "What can I do in HealthPass today?",
      answer:
        "The current experience covers patient accounts, signed visit history, patient-controlled sharing and activity history. Professional accounts support patient registration and clinical notes. Prescriptions, lab-result exchange, appointments, consultations and partner integrations are planned, and are not available in this version.",
    },
    {
      question: "How does a care team get access?",
      answer:
        "Professional accounts are provisioned through facility onboarding and require reviewed membership before clinical access is enabled. Professionals also complete authenticator verification. If your facility has not been onboarded, creating a patient account will not grant professional access.",
    },
    {
      question: "Can I change a signed clinical note?",
      answer:
        "Signed notes preserve their original version. An authorized clinician can add an amendment with a reason, while the previous signed version stays in the record. Patients and other facilities cannot rewrite the source note.",
    },
    {
      question: "Is HealthPass an emergency service?",
      answer:
        "No. HealthPass is a care-record workspace and does not provide emergency response. If you need urgent help, contact an appropriate local emergency service or visit a care facility.",
    },
  ];
  return (
    <section id="faq" className="hp-landing-section hp-landing-wrap hp-landing-faq">
      <div>
        <span className="hp-landing-eyebrow">A few useful answers</span>
        <h2>
          Before you
          <br />
          get started.
        </h2>
        <p>Know what you're signing up for, and how access works.</p>
      </div>
      <div>
        {questions.map(({ question, answer }) => (
          <details key={question}>
            <summary>
              {question}
              <ChevronDown size={19} aria-hidden="true" />
            </summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

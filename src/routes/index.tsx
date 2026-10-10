import { createFileRoute } from "@tanstack/react-router";
import {
  ShieldCheck,
  FileHeart,
  Pill,
  Building2,
  UserRound,
  Stethoscope,
  ArrowRight,
  Check,
  QrCode,
  Share2,
} from "lucide-react";
import heroImg from "@/assets/hero-patient.jpg";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header />
      <Hero />
      <TrustStrip />
      <Features />
      <HowItWorks />
      <ForProviders />
      <CTA />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <a href="#" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--gradient-hero)] text-primary-foreground shadow-[var(--shadow-soft)]">
            <FileHeart className="h-4 w-4" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">Health Pass</span>
        </a>
        <nav className="hidden items-center gap-8 text-sm text-muted-foreground md:flex">
          <a href="#features" className="hover:text-foreground">
            Features
          </a>
          <a href="#how" className="hover:text-foreground">
            How it works
          </a>
          <a href="#providers" className="hover:text-foreground">
            For providers
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <a
            href="/care"
            className="hidden text-sm text-muted-foreground hover:text-foreground sm:block"
          >
            Sign in
          </a>
          <a
            href="#cta"
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-[var(--shadow-soft)] transition hover:brightness-110"
          >
            Get your pass <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.06]"
        style={{
          backgroundImage:
            "radial-gradient(circle at 1px 1px, var(--maroon-deep) 1px, transparent 0)",
          backgroundSize: "22px 22px",
        }}
      />
      <div className="mx-auto grid max-w-6xl gap-12 px-6 pt-16 pb-24 md:grid-cols-2 md:items-center md:pt-24">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium uppercase tracking-wider text-primary">
            <ShieldCheck className="h-3.5 w-3.5" /> Patient-owned EMR
          </span>
          <h1 className="mt-5 font-display text-5xl leading-[1.05] font-semibold tracking-tight text-foreground md:text-6xl">
            Your health,{" "}
            <span className="bg-[var(--gradient-hero)] bg-clip-text text-transparent">
              in one passport.
            </span>
          </h1>
          <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
            Health Pass is a patient-first health passport. Carry every visit, prescription and lab
            result with you — across clinics, pharmacies and hospitals, even the ones that don't use
            Health Pass yet.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href="#cta"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-[var(--shadow-elegant)] transition hover:brightness-110"
            >
              Create your pass <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#how"
              className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-6 py-3 text-sm font-medium text-foreground transition hover:border-primary/40"
            >
              See how it works
            </a>
          </div>
          <dl className="mt-10 grid max-w-md grid-cols-3 gap-6 border-t border-border pt-6">
            <Stat k="1" v="passport" />
            <Stat k="∞" v="facilities" />
            <Stat k="100%" v="yours" />
          </dl>
        </div>

        <div className="relative">
          <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-[var(--gradient-hero)] opacity-20 blur-2xl" />
          <div className="overflow-hidden rounded-[2rem] border border-border bg-card shadow-[var(--shadow-elegant)]">
            <img
              src={heroImg}
              alt="Patient holding a phone showing their Health Pass record"
              width={1536}
              height={1536}
              className="h-full w-full object-cover"
            />
          </div>
          <FloatingCard
            className="absolute -left-4 bottom-6 md:-left-10"
            icon={<Pill className="h-4 w-4" />}
            title="Refill logged"
            subtitle="Metformin · Nairobi Chemist"
          />
          <FloatingCard
            className="absolute -right-2 top-8 md:-right-8"
            icon={<Stethoscope className="h-4 w-4" />}
            title="Visit synced"
            subtitle="Aga Khan · Cardiology"
          />
        </div>
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="font-display text-3xl font-semibold text-primary">{k}</dt>
      <dd className="mt-1 text-xs uppercase tracking-wider text-muted-foreground">{v}</dd>
    </div>
  );
}

function FloatingCard({
  className = "",
  icon,
  title,
  subtitle,
}: {
  className?: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border border-border bg-card/95 px-4 py-3 shadow-[var(--shadow-soft)] backdrop-blur ${className}`}
    >
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </span>
      <div>
        <div className="text-sm font-medium leading-tight">{title}</div>
        <div className="text-xs text-muted-foreground">{subtitle}</div>
      </div>
    </div>
  );
}

function TrustStrip() {
  const items = [
    "HIPAA-aligned",
    "End-to-end encrypted",
    "Patient-controlled sharing",
    "Works offline",
  ];
  return (
    <section className="border-y border-border bg-secondary/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-10 gap-y-3 px-6 py-5 text-xs uppercase tracking-[0.15em] text-muted-foreground">
        {items.map((i) => (
          <span key={i} className="flex items-center gap-2">
            <Check className="h-3.5 w-3.5 text-primary" /> {i}
          </span>
        ))}
      </div>
    </section>
  );
}

function Features() {
  const features = [
    {
      icon: <FileHeart className="h-5 w-5" />,
      title: "One lifelong record",
      body: "Every visit, diagnosis, allergy and vaccination lives in one place — no more paper folders or lost histories.",
    },
    {
      icon: <Pill className="h-5 w-5" />,
      title: "Log every refill",
      body: "Bought medicine at a different pharmacy? Snap the receipt or ask staff to add it. Your medication list stays complete.",
    },
    {
      icon: <Building2 className="h-5 w-5" />,
      title: "Any facility, any system",
      body: "Providers who don't use Health Pass can still contribute. Records are added by you or by them in seconds.",
    },
    {
      icon: <Share2 className="h-5 w-5" />,
      title: "Share on your terms",
      body: "Grant a doctor time-boxed access with a QR code. Revoke it whenever you want.",
    },
    {
      icon: <ShieldCheck className="h-5 w-5" />,
      title: "Owned by you",
      body: "Your passport belongs to you — not a hospital chain, not an insurer. Export anything, anytime.",
    },
    {
      icon: <QrCode className="h-5 w-5" />,
      title: "Emergency-ready",
      body: "A scannable emergency card surfaces allergies, blood type and active meds when it matters most.",
    },
  ];

  return (
    <section id="features" className="mx-auto max-w-6xl px-6 py-24">
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">Features</p>
        <h2 className="mt-3 font-display text-4xl font-semibold tracking-tight md:text-5xl">
          Built around the patient — not the facility.
        </h2>
        <p className="mt-4 text-muted-foreground">
          Health Pass flips the EMR model. Instead of records trapped in each clinic, the record
          travels with you.
        </p>
      </div>

      <div className="mt-14 grid gap-px overflow-hidden rounded-3xl border border-border bg-border md:grid-cols-2 lg:grid-cols-3">
        {features.map((f) => (
          <div key={f.title} className="group bg-card p-8 transition hover:bg-secondary/60">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary transition group-hover:bg-primary group-hover:text-primary-foreground">
              {f.icon}
            </span>
            <h3 className="mt-5 font-display text-xl font-semibold">{f.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Create your pass",
      body: "Sign up in under a minute. Import past records or start fresh.",
    },
    {
      n: "02",
      title: "Log visits & refills",
      body: "Add prescriptions, lab results and doctor notes from any facility — or ask staff to add them for you.",
    },
    {
      n: "03",
      title: "Share when it matters",
      body: "A new doctor scans your QR and sees exactly what you allow, for as long as you allow.",
    },
  ];

  return (
    <section id="how" className="bg-[var(--gradient-hero)] text-primary-foreground">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary-foreground/70">
            How it works
          </p>
          <h2 className="mt-3 font-display text-4xl font-semibold tracking-tight md:text-5xl">
            Three steps to a portable medical history.
          </h2>
        </div>
        <ol className="mt-14 grid gap-6 md:grid-cols-3">
          {steps.map((s) => (
            <li
              key={s.n}
              className="rounded-2xl border border-primary-foreground/15 bg-primary-foreground/5 p-7 backdrop-blur"
            >
              <div className="font-display text-4xl font-semibold text-primary-foreground/70">
                {s.n}
              </div>
              <h3 className="mt-4 font-display text-xl font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-primary-foreground/80">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ForProviders() {
  return (
    <section id="providers" className="mx-auto max-w-6xl px-6 py-24">
      <div className="grid gap-12 rounded-3xl border border-border bg-card p-8 shadow-[var(--shadow-soft)] md:grid-cols-2 md:p-14">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            For providers
          </p>
          <h2 className="mt-3 font-display text-4xl font-semibold tracking-tight">
            A cleaner intake, without switching your EMR.
          </h2>
          <p className="mt-4 text-muted-foreground">
            Scan a patient's Health Pass to instantly see their history, active meds and allergies.
            Add a note, a prescription or a lab result back to their record in seconds — no
            integration required.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href="#cta"
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:brightness-110"
            >
              Join as a provider <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href="#"
              className="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium transition hover:border-primary/40"
            >
              Read the provider guide
            </a>
          </div>
        </div>
        <ul className="grid gap-4 md:grid-cols-2">
          {[
            { icon: <UserRound className="h-4 w-4" />, t: "Full patient context in one scan" },
            { icon: <Pill className="h-4 w-4" />, t: "Add prescriptions & refills" },
            { icon: <FileHeart className="h-4 w-4" />, t: "Attach lab results and notes" },
            { icon: <ShieldCheck className="h-4 w-4" />, t: "Consent-based, audit-logged" },
          ].map((i) => (
            <li
              key={i.t}
              className="flex items-start gap-3 rounded-2xl border border-border bg-background p-4"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                {i.icon}
              </span>
              <span className="text-sm leading-snug">{i.t}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section id="cta" className="mx-auto max-w-6xl px-6 pb-24">
      <div className="relative overflow-hidden rounded-3xl bg-[var(--gradient-hero)] p-10 text-primary-foreground shadow-[var(--shadow-elegant)] md:p-16">
        <div className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary-foreground/10 blur-3xl" />
        <div className="relative max-w-2xl">
          <h2 className="font-display text-4xl font-semibold tracking-tight md:text-5xl">
            Start your Health Pass today.
          </h2>
          <p className="mt-4 text-primary-foreground/80">
            Free for patients. Always. Bring your full medical history with you — everywhere you get
            care.
          </p>
          <form
            className="mt-8 flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => e.preventDefault()}
          >
            <input
              type="email"
              required
              placeholder="you@email.com"
              className="w-full rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-5 py-3 text-sm text-primary-foreground placeholder:text-primary-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary-foreground/40"
            />
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 rounded-full bg-primary-foreground px-6 py-3 text-sm font-medium text-primary transition hover:brightness-95"
            >
              Get early access <ArrowRight className="h-4 w-4" />
            </button>
          </form>
          <p className="mt-3 text-xs text-primary-foreground/60">
            No spam. We'll only email you about your pass.
          </p>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-secondary/40">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-10 md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--gradient-hero)] text-primary-foreground">
            <FileHeart className="h-4 w-4" />
          </span>
          <span className="font-display text-lg font-semibold">Health Pass</span>
        </div>
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} Health Pass. The passport for your health.
        </p>
        <div className="flex gap-6 text-xs text-muted-foreground">
          <a href="#" className="hover:text-foreground">
            Privacy
          </a>
          <a href="#" className="hover:text-foreground">
            Terms
          </a>
          <a href="#" className="hover:text-foreground">
            Contact
          </a>
        </div>
      </div>
    </footer>
  );
}

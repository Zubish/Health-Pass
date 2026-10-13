# HealthPass App Blueprint

Established 2026-10-13. No existing blueprint was found in this repository. This document preserves the patient-first vision while separating the current public product scope from future integration objectives. The checked-out repository contains an older landing-page implementation; its aspirational copy is not evidence that production workflows exist.

## Vision And Product Boundary

HealthPass is the care-history and controlled-sharing layer of the ecosystem: help patients and authorised care teams retain useful context between visits without granting every organisation access to the same record.

- HealthPass: patient identity, signed care history, source provenance, controlled sharing and access history.
- RxLedger: pharmacy inventory, sales, dispensing and patient continuity.
- Rai: a separate planned care-support layer; do not imply connected AI assistance is available.
- Integration must strengthen continuity while each product remains useful independently. HealthPass is not a pharmacy POS, insurer, universal hospital EMR or emergency-response service.

## Current Scope And Claims Boundary

Baseline: [the current public HealthPass experience](https://health-pass-psi.vercel.app/), reviewed in the accompanying transcript-analysis discussion. This is a public scope statement, not an independent end-to-end verification of every feature.

The public scope covers patient accounts, signed clinical/visit history, patient-controlled sharing and activity history. Participating professional teams register patients and document, sign or amend clinical notes. Availability depends on participating facilities.

Prescriptions, laboratory-result exchange, appointments, consultations, RxLedger integration and AI support are planned. Do not present these as implemented, or claim universal facility access, offline operation, end-to-end encryption or regulatory certification without technical and operational evidence. The older repository landing copy requires a separate implementation review against this boundary.

## Identity, Sharing And Record Integrity

- Patient identity must not be inferred from a shared phone number alone. Define safe identity verification and reconciliation before connecting external records.
- Professional access requires verified facility membership and the appropriate role. Patient signup must not create professional privileges.
- Cross-facility sharing is an explicit, scoped, time-limited patient grant with review and revocation. Revocation ends future shared access; it does not delete the source facility's own care record.
- Preserve signed source records. Authorised amendments retain the original version, author, reason and time; another facility must not rewrite the source note.
- Missing information stays unknown. Absence of a recorded allergy must not be interpreted as no known allergies.
- Clinical changes and allowed/denied access must remain auditable. Operational telemetry must avoid clinical content.

## Infrastructure Lessons From The Interview

Source: user-provided transcript of [the healthcare infrastructure interview](https://youtu.be/ChcXqdcHDTY). Timestamped observations below inform planning; they do not demonstrate our implementation or a partnership. Interview date, speaker/company spelling and numerical market claims need independent verification before external attribution or use as current statistics.

### Care Context And Workflow Research

At 7:15–7:35 the discussion describes difficulty locating records and long hospital queues. HealthPass addresses accessible care context; queue management and waiting-time reduction require separate workflow design and evidence.

- Observe patients, reception teams and clinicians retrieving records, documenting visits, sharing history and resolving mistaken identities (research lesson: 1:16–1:28).
- Test whether an authorised next care team can obtain the right signed context with less repeated explanation, without expanding access unnecessarily.
- Include smaller facilities, locations beyond major cities, low-end phones and weak connections. Validate local differences before broad rollout (7:51–8:15).

### Interoperability Before Ecosystem Expansion

At 5:54–6:36 the interview describes isolated systems and the need for a shared medicine schema; at 4:23–4:36 it describes infrastructure others can reuse.

- Preserve source facility, clinician, timestamps, status and version on exchanged records. Standardise meaning as well as field names; unknown or unmapped information must stay explicit.
- Define versioned exchange contracts, stable identifiers, authenticated partner scopes, acknowledgements, idempotency, error handling and audit trails. Evaluate applicable standards such as FHIR; do not claim standards compliance before validation.
- Prescription exchange must preserve ingredient(s), strength, dosage form, release characteristics, route where relevant, instructions, quantity/units and source identifiers. RxLedger medicine mappings require provenance and pharmacist review of ambiguity; equivalent naming is not permission to substitute therapy.
- Agree patient identity matching, purpose, permission scope, revocation/expiry behaviour and system-of-record responsibilities before integrations. A sharing grant is not a blanket right to export the entire record into every partner system.
- A future RxLedger connection may send authorised prescription context and return confirmed dispensing feedback. Request, acceptance, reservation, dispensing and cancellation are distinct states; a sale does not prove adherence.
- Read RxLedger's [ecosystem map](https://github.com/Zubish/RxLedger/blob/master/docs/RXLEDGER_ECOSYSTEM_MODULES.md) and [Care Network blueprint](https://github.com/Zubish/RxLedger/blob/master/docs/FREEZE_II_CARE_NETWORK_FIGMA_BLUEPRINT.md) before designing the connection. Preserve one-pharmacy fulfilment for the initial network pilot; split fulfilment remains later work.

### Connectivity And Record Safety

At 9:47–10:12 connectivity affects operational work. Device compatibility must not be conflated with proven offline operation.

- Prioritise bounded loading, readable phone interfaces, clear loading/failure/pending states and recovery from interrupted requests.
- Test note-save/sign/amend and sharing actions under retry, reconnect and session expiry. Avoid duplicate encounters, silent lost edits or a failed revocation shown as successful.
- Any future offline capability requires explicit allowed data, secure local retention, expiry/deletion policy, identity and permissions checks, conflict reconciliation and server acknowledgements.
- Document limitations around already-cached records and revoked/expired sharing before permitting offline clinical access. Do not offer universal offline access as a shortcut around patient control.

### Partnership And Affordability Boundaries

At 4:02–4:15 public–private partnership is proposed as a route to shared infrastructure, not reported as an existing agreement. At 11:09–11:50 funding, collaboration and technology are complementary needs.

- First demonstrate a private participating-facility/pharmacy pilot. Public-sector engagement may follow proven outcomes; no government endorsement or national affiliation is implied.
- A future programme must define the public sponsor, facilities, pharmacies, professional/approval responsibilities, support, reimbursement where relevant and evaluation criteria.
- Public programme participation does not grant blanket access to patient records. Clinical exchange and programme analytics have separate purposes, scopes and governance.
- Aggregate evaluation should minimise data and suppress small groups that could identify patients. Review applicable Nigerian data-protection and professional requirements for the proposed workflow.
- Insurance participation and affordability require actual financing partners (9:19–9:26, 12:27–13:10). A care-history platform alone does not lower medicine prices, provide coverage or guarantee access.

## Delivery Sequence And Pilot Measures

1. Validate patient identity, facility membership, record integrity, sharing and audit behaviour in the actual deployed application.
2. Observe record retrieval and sharing on real devices and weak connections; address workflow and permission failures.
3. Define interoperability contracts and medicine/identity mappings with RxLedger before implementing prescription/dispensing exchange.
4. Pilot with a small participating care network; expand public/HMO participation only after responsibilities, economics, permissions and outcomes are established.

For each pilot metric, specify baseline, denominator, observation window and data owner: time to retrieve authorised history; successful grant/revoke/access tasks; record provenance completeness; amendment integrity; identity mismatches; unauthorised access attempts; mobile task completion; interrupted-save recovery; and, after integration, authorised prescription-to-confirmed-dispensing completion. Do not claim reduced queues, improved adherence or clinical outcomes from usage counts alone.

## Public Communication

Describe the current scope plainly and label planned integrations. The founder's pharmacy/software-engineering background motivates the work but does not replace professional validation, pharmacy/facility research or measured outcomes. Credit the interview with verified names and timestamp context; do not turn its historical statistics into current facts or its suggested partnership into an existing affiliation.

# Workspace UX sweep — 13 October 2026

Owner requested a broad desktop/tablet/mobile correction after screenshots showed loose department controls, excessive space, stretched security checkboxes and unnecessary generic text.

Root causes included undefined hp-primary/hp-secondary button classes, missing choice/form-grid/section-heading layouts, unbounded full-width security panels, nested paragraph markup in admission cards and overflowing sidebar role lists.

Changes: use the existing hp-button variants; supply shared heading, action-row, two-column form and checkbox styles; constrain workspace content to 1280px; group security settings in desktop columns and stack on smaller screens; align/pad department filters and cards; improve text contrast and touch targets; keep full role details in the account tooltip while showing a compact role summary. Signed records, permissions and authentication rules are unchanged.

Copy cleanup removes workspace marketing, repeated technical explanations and decorative status metrics. Session activity uses readable labels instead of internal route names and shows six recent items with an expansion action. The environment indicator stays truthful but compact. Useful clinical instructions, sharing explanations at decision points, sign-in alerts and author/timestamp information remain visible.

Local verification: TypeScript and production build pass. Browser checks covered GP, patient, administrator and laboratory screens at 320, 390, 768, 1024, 1440 and 1920px (174 combinations), including populated department cards and empty screens. No page overflow or browser errors. Additional checks verify checkbox dimensions, a persisted eight-hour preference change, request/prescribing dialogs and back/forward navigation. Screenshot review covered desktop security cards and mobile department records. All fixtures are synthetic. Affected component lint has no errors; four pre-existing useEffect dependency warnings remain in care-workspace.tsx.

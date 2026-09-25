# Fenton preterm growth chart — source data

The clean 2025 "both sexes" LMS reference file Dr. Tanis Fenton (Cumming
School of Medicine, University of Calgary) sent by email, 2026-09-25, is
**deliberately not stored in this repo.** It was committed here briefly and
removed — this repo is public, and committing it violated the exact
condition Dr. Fenton's license places on this data (never shared with
other organizations; a public GitHub repo is broader than that). Keep the
actual file somewhere private instead (local device storage, a private
Drive folder, etc.), never in a public git history.

**Verification note (2026-09-25):** before it was removed, the 2,284 rows
already seeded into `fenton_preterm_lms` (originally extracted from an
earlier file she sent — `2025_Girls_Fenton_2025_Growth_Chart_Clinical_Calculator_v1_23_Unprotected.xlsx`,
also never committed here — which, despite the "Girls" filename, had a
full boys table embedded in its calculator's helper lookup columns) were
cross-checked against this file's `daily LMS & key percentiles` sheet:
**0 mismatches** across both sexes, all three metrics (weight/length/hc).
Nothing needed correcting.

## License

Same condition as everywhere else Fenton data appears in this repo — see
`sql/013_add_fenton_preterm.sql`. CC BY-NC-ND 4.0, non-commercial, this
application only. The underlying data must never be exposed raw via the
API (no list/dump route, ever), never committed to this or any other
public repo, and never shared with other organizations.

## 2013 reference

No separate "clean" 2013 source has been sent (the 2013 LMS values in
`fenton_preterm_lms` were extracted the same way the first 2025 file was —
from a calculator's helper columns). If one ever arrives, keep it private
too, not in this repo.

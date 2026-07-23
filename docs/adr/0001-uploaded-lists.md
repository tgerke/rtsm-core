# ADR-0001: Randomization lists are uploaded, not generated in-app

Status: accepted (2026-07-23)

## Context

An RTSM needs a randomization list. It can either generate one (blocks,
stratification, seed management) or import one produced outside the system.
edc-core's ADR-0016 cited E6(R3) Annex 1 §4.3.4(h), which names
randomisation as critical functionality for system validation: an in-app
generator would put a statistical algorithm inside this application's
validation envelope and re-open it with every release.

The people who design randomization schemes for our trials are
biostatisticians working in validated statistical environments (typically R)
whose block structures, allocation ratios, and seeds are specified in the
protocol and reviewed on their own terms.

## Decision

v0.1 imports a statistician-generated CSV and never generates entries. The
format is deliberately rigid, documented, and validated on import:

- Header `seq,arm` or `seq,arm,stratum`; one entry per line.
- `seq` is a unique positive integer; allocation within a stratum follows
  ascending `seq`.
- `stratum` is an opaque exact-match label (empty = unstratified). Mapping
  subject covariates to a label is protocol logic that stays with the
  statistician's specification, not application code.
- Fields must not contain commas or quotes; this is not a general CSV
  dialect, so there is nothing to interpret.

Integrity: the file's sha256 is stored on the list, entries are append-only
by trigger once imported, and imports create new versions rather than
modifying anything. The stored content stays provably tied to what the
statistician generated.

## Consequences

- The statistical validation burden (generation) stays outside the
  application; the application's burden is faithful storage, ordered
  allocation, and blinding, which is what its tests cover.
- Block structure is invisible to this system on purpose; it allocates
  strictly by `seq` within a stratum.
- In-app generation is roadmap, and only if a validated generator earns a
  place; uploading remains the default even then.

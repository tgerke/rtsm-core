---
title: Randomization list format
description: The CSV contract between the statistician's generation code and rtsm-core.
---

rtsm-core imports randomization lists; it never generates them (ADR-0001).
The list is produced outside the system — typically by a biostatistician in
R, under the protocol's randomization specification — and imported as a
versioned draft.

## Format

Header `seq,arm` or `seq,arm,stratum`, one entry per line:

```csv
seq,arm,stratum
1,Arm A,site-A:high
2,Arm B,site-A:high
3,Arm B,site-A:low
4,Arm A,site-A:low
```

Rules, enforced on import:

- `seq`: unique positive integer. Allocation within a stratum follows
  ascending `seq`; block structure is invisible to rtsm-core on purpose.
- `arm`: non-empty, at most 500 characters. Delivered verbatim to the EDC's
  blinded item.
- `stratum`: opaque label matched exactly at randomization time; empty (or
  the two-column form) means an unstratified list. Encoding covariates into
  the label (and telling coordinators which label to use) is protocol
  logic that stays with the statistician's specification.
- No commas or quotes inside fields. This is deliberately not a general CSV
  dialect; there is nothing for an importer to interpret.

## Integrity and lifecycle

The file's sha256 is stored on the list and shown in the UI; entries are
append-only in the database once imported, so stored content stays provably
tied to the generated file. Imports create new versions. Activation — the
step that opens a list for allocation — requires the activator to re-enter
their password and record a reason, retires any previously active list, and
is written to the audit chain.

## Example generation in R

```r
# 1:1 blocks of 4 within each stratum; seed per protocol.
library(blockrand)
set.seed(20260723)
strata <- c("site-A:high", "site-A:low")
lst <- lapply(strata, function(s) {
  b <- blockrand(n = 24, num.levels = 2, levels = c("Arm A", "Arm B"),
                 block.sizes = 2)
  data.frame(arm = b$treatment, stratum = s)
})
df <- do.call(rbind, lst)
df <- data.frame(seq = seq_len(nrow(df)), arm = df$arm, stratum = df$stratum)
write.csv(df, "list.csv", row.names = FALSE, quote = FALSE)
```

Validate the generated allocation independently (ratios, block integrity,
per-stratum counts) before import; rtsm-core checks the format, not the
statistics.

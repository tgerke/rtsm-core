# R reference implementation of the Pocock–Simon minimization step
# (ADR-0008). This is the statistician-reviewable oracle: the TypeScript
# engine (packages/core/src/minimize.ts) must agree with it case by case,
# proven by the golden vectors this script generates
# (packages/core/test-vectors/minimization-vectors.json) and the test that
# replays them. Regenerate with:
#
#   Rscript tools/minimization-reference.R
#
# Scope matches the accepted design exactly: range imbalance metric only,
# equal allocation ratios, biased coin p on the favored set with ties
# splitting the favored probability equally, and an all-arm tie (including
# the first subject) falling back to a pure equal-probability draw.
# Pocock & Simon (1975), Biometrics 31:103-115.

# One candidate evaluation: the weighted sum, across factors, of the range
# (max - min) of arm counts at the subject's level, after hypothetically
# assigning the subject to `candidate`.
imbalance_score <- function(candidate, arms, factors, counts, covariates) {
  score <- 0
  for (f in factors) {
    level <- covariates[[f$name]]
    level_counts <- vapply(
      arms,
      function(arm) {
        n <- counts[[f$name]][[level]][[arm]]
        if (is.null(n)) n <- 0
        n + as.integer(arm == candidate)
      },
      numeric(1)
    )
    score <- score + f$weight * (max(level_counts) - min(level_counts))
  }
  score
}

minimize_step <- function(arms, factors, p, counts, covariates) {
  scores <- vapply(
    arms,
    imbalance_score,
    numeric(1),
    arms = arms, factors = factors, counts = counts, covariates = covariates
  )
  favored <- arms[scores == min(scores)]
  if (length(favored) == length(arms)) {
    probs <- rep(1 / length(arms), length(arms))
  } else {
    probs <- ifelse(
      arms %in% favored,
      p / length(favored),
      (1 - p) / (length(arms) - length(favored))
    )
  }
  names(probs) <- arms
  list(imbalanceScores = as.list(scores), armProbabilities = as.list(probs))
}

# --- deterministic scenario battery -----------------------------------------

set.seed(20260731) # scenario construction only; the step itself draws nothing

random_counts <- function(arms, factors, lambda) {
  counts <- list()
  for (f in factors) {
    counts[[f$name]] <- list()
    for (level in f$levels) {
      arm_counts <- as.list(rpois(length(arms), lambda))
      names(arm_counts) <- arms
      counts[[f$name]][[level]] <- arm_counts
    }
  }
  counts
}

configs <- list(
  list(
    label = "two-arm, one factor, uniform weights",
    arms = c("A", "B"),
    factors = list(list(name = "stage", levels = c("I", "II"), weight = 1)),
    p = 0.8
  ),
  list(
    label = "two-arm, site + stage, site downweighted",
    arms = c("A", "B"),
    factors = list(
      list(name = "site", levels = c("S1", "S2", "S3"), weight = 0.5),
      list(name = "stage", levels = c("I", "II", "III"), weight = 2)
    ),
    p = 0.8
  ),
  list(
    label = "three-arm, two factors",
    arms = c("A", "B", "C"),
    factors = list(
      list(name = "sex", levels = c("F", "M"), weight = 1),
      list(name = "risk", levels = c("low", "high"), weight = 1)
    ),
    p = 0.7
  ),
  list(
    label = "four-arm, three factors, mixed weights, p at bounds",
    arms = c("A", "B", "C", "D"),
    factors = list(
      list(name = "site", levels = c("S1", "S2"), weight = 1),
      list(name = "stage", levels = c("I", "II", "III", "IV"), weight = 1.5),
      list(name = "ecog", levels = c("0", "1", "2"), weight = 0.25)
    ),
    p = 0.95
  )
)

vectors <- list()
for (cfg in configs) {
  # First subject: all counts zero, all arms tie, pure random.
  zero <- random_counts(cfg$arms, cfg$factors, 0)
  covariates <- lapply(cfg$factors, function(f) f$levels[[1]])
  names(covariates) <- vapply(cfg$factors, function(f) f$name, character(1))
  vectors[[length(vectors) + 1]] <- list(
    label = paste(cfg$label, "- first subject"),
    arms = cfg$arms, factors = cfg$factors, p = cfg$p,
    counts = zero, covariates = covariates,
    expected = minimize_step(cfg$arms, cfg$factors, cfg$p, zero, covariates)
  )
  # Accrued trials at three enrollment depths, three covariate profiles each.
  for (lambda in c(2, 8, 25)) {
    counts <- random_counts(cfg$arms, cfg$factors, lambda)
    for (draw in 1:3) {
      covariates <- lapply(cfg$factors, function(f) sample(f$levels, 1))
      names(covariates) <- vapply(cfg$factors, function(f) f$name, character(1))
      vectors[[length(vectors) + 1]] <- list(
        label = sprintf("%s - lambda %d, profile %d", cfg$label, lambda, draw),
        arms = cfg$arms, factors = cfg$factors, p = cfg$p,
        counts = counts, covariates = covariates,
        expected = minimize_step(cfg$arms, cfg$factors, cfg$p, counts, covariates)
      )
    }
  }
}

out <- file.path("packages", "core", "test-vectors", "minimization-vectors.json")
dir.create(dirname(out), recursive = TRUE, showWarnings = FALSE)
jsonlite::write_json(
  vectors, out,
  auto_unbox = TRUE, digits = NA, pretty = TRUE
)
cat(sprintf("wrote %d vectors to %s\n", length(vectors), out))

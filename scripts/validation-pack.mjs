#!/usr/bin/env node
// Validation pack generator (P11-05).
//
// Runs the automated test suite with JSON reporters, then joins the results
// to docs/regulatory-traceability.md: every requirement row that cites test
// evidence gets the actual pass/fail record of those tests for this exact
// commit. The output (validation-pack/) ships with each release so adopters
// can build on vendor testing instead of re-deriving it.
//
// Exits non-zero if any test fails OR any cited evidence file produced no
// results (e.g. database-dependent suites were skipped) — a pack with holes
// is not evidence.

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "validation-pack");
const evidenceDir = path.join(outDir, "evidence");

// The whole suite lives in apps/api (the compliance tests connect as both the
// owner and rtsm_app; the engine tests replay the committed R oracle vectors).
const PACKAGES = [{ name: "@rtsm-core/api", dir: "apps/api" }];

function sh(cmd) {
  return execSync(cmd, { cwd: root, encoding: "utf8" }).trim();
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(evidenceDir, { recursive: true });

// 1. Run every workspace's tests with a JSON reporter.
const suites = [];
for (const pkg of PACKAGES) {
  const outputFile = path.join(evidenceDir, `${pkg.dir.replaceAll("/", "-")}.json`);
  console.log(`\n▶ ${pkg.name}`);
  const run = spawnSync(
    "pnpm",
    [
      "--filter",
      pkg.name,
      "exec",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${outputFile}`,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (run.status !== 0) {
    console.error(`✗ ${pkg.name} test run failed`);
    process.exit(1);
  }
  suites.push({ pkg, results: JSON.parse(readFileSync(outputFile, "utf8")) });
}

// 2. Index results by test file basename.
const byFile = new Map();
const totals = { total: 0, passed: 0, failed: 0, skipped: 0 };
const packageSummaries = [];
for (const { pkg, results } of suites) {
  packageSummaries.push({
    package: pkg.name,
    total: results.numTotalTests,
    passed: results.numPassedTests,
    failed: results.numFailedTests,
    skipped: results.numPendingTests + (results.numTodoTests ?? 0),
  });
  totals.total += results.numTotalTests;
  totals.passed += results.numPassedTests;
  totals.failed += results.numFailedTests;
  totals.skipped += results.numPendingTests + (results.numTodoTests ?? 0);
  for (const fileResult of results.testResults) {
    const base = path.basename(fileResult.name);
    const entry = byFile.get(base) ?? { package: pkg.name, tests: [] };
    for (const assertion of fileResult.assertionResults) {
      entry.tests.push({ title: assertion.fullName, status: assertion.status });
    }
    byFile.set(base, entry);
  }
}

// 3. Parse the traceability matrix. Rows are | ID | requirement | enforced
// by | proven by |; citations carry their path (`routes/methods.test.ts`),
// results are joined on the basename. Rows whose proof is architectural or
// a service file (no *.test.ts citation) are reported without test evidence.
const matrix = readFileSync(path.join(root, "docs/regulatory-traceability.md"), "utf8");
const requirements = [];
for (const line of matrix.split("\n")) {
  const m = line.match(/^\| ((?:P11|BL|TL|SUP|RA)-\d+) \| (.+?) \| (.+?) \| (.+?) \|$/);
  if (!m) continue;
  const [, id, requirement, mechanism, provenCell] = m;
  const evidence = [];
  for (const ref of provenCell.matchAll(/`([\w./-]+\.test\.ts)`/g)) {
    const file = path.basename(ref[1]);
    const found = byFile.get(file);
    const executed = found ? found.tests.filter((t) => t.status !== "pending") : [];
    evidence.push({
      file,
      package: found?.package ?? null,
      passed: executed.filter((t) => t.status === "passed").length,
      failed: executed.filter((t) => t.status === "failed").length,
      tests: found?.tests ?? [],
    });
  }
  requirements.push({ id, requirement, mechanism, proof: provenCell, evidence });
}

// 4. Integrity checks: no failures, no empty evidence.
const problems = [];
if (totals.failed > 0) problems.push(`${totals.failed} test(s) failed`);
if (requirements.length === 0) problems.push("no requirement rows parsed from the matrix");
for (const req of requirements) {
  for (const ev of req.evidence) {
    const executed = ev.passed + ev.failed;
    if (executed === 0) {
      problems.push(
        `${req.id} cites ${ev.file} but no tests executed from it (missing file or skipped suite — is the database up?)`,
      );
    }
    if (ev.failed > 0) problems.push(`${req.id} evidence ${ev.file} has failing tests`);
  }
}

// 5. Emit the pack.
const meta = {
  generatedAt: new Date().toISOString(),
  version: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
  gitCommit: sh("git rev-parse HEAD"),
  gitDescribe: sh("git describe --always --dirty --tags"),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
};
const pack = {
  meta,
  success: problems.length === 0,
  problems,
  totals,
  packageSummaries,
  requirements,
};
writeFileSync(path.join(outDir, "validation-pack.json"), JSON.stringify(pack, null, 2));

const withEvidence = requirements.filter((r) => r.evidence.length > 0);
const md = [
  "# rtsm-core validation pack",
  "",
  `Generated ${meta.generatedAt} · version ${meta.version} · commit \`${meta.gitCommit.slice(0, 12)}\` · node ${meta.node} · ${meta.platform}`,
  "",
  "This pack joins the [regulatory traceability matrix](../docs/regulatory-traceability.md) to the",
  "automated test results for this exact commit (P11-05). Sponsors validate their own",
  "implementation; this evidence exists to make that validation cheap.",
  "",
  `**Result: ${problems.length === 0 ? "✅ PASS" : "❌ FAIL"}** — ${totals.passed}/${totals.total} tests passed` +
    (totals.skipped ? ` (${totals.skipped} skipped)` : "") +
    `, ${withEvidence.length}/${requirements.length} requirements carry test evidence.`,
  ...(problems.length > 0 ? ["", "## Problems", "", ...problems.map((p) => `- ${p}`)] : []),
  "",
  "## Test suites",
  "",
  "| Package | Total | Passed | Failed | Skipped |",
  "|---|---|---|---|---|",
  ...packageSummaries.map(
    (s) => `| ${s.package} | ${s.total} | ${s.passed} | ${s.failed} | ${s.skipped} |`,
  ),
  "",
  "## Requirement evidence",
  "",
];
for (const req of requirements) {
  md.push(`### ${req.id} — ${req.requirement}`, "", `${req.mechanism}`, "");
  if (req.evidence.length === 0) {
    md.push(`_No test citation; proven by: ${req.proof}_`, "");
    continue;
  }
  for (const ev of req.evidence) {
    md.push(
      `**\`${ev.file}\`** (${ev.package ?? "not found"}): ${ev.passed} passed, ${ev.failed} failed`,
      "",
    );
    for (const t of ev.tests) {
      const mark = t.status === "passed" ? "✅" : t.status === "failed" ? "❌" : "⏭";
      md.push(`- ${mark} ${t.title}`);
    }
    md.push("");
  }
}
writeFileSync(path.join(outDir, "validation-pack.md"), md.join("\n"));

console.log(`\n${problems.length === 0 ? "✅" : "❌"} validation pack written to validation-pack/`);
for (const p of problems) console.error(`  - ${p}`);
process.exit(problems.length === 0 ? 0 : 1);

#!/usr/bin/env node
// Upstream drift audit for the vendored @vibe-cafe/vibe-usage CLI.
//
// Why this exists: `vibeUsageCliChannel: "latest"` is consumed only by
// scripts/vendor-cli.mjs, which runs on a developer machine. The release
// workflow never re-vendors — it re-runs check-version.mjs against the snapshot
// committed in this repository, on purpose, so a release cannot be silently
// replaced by code nobody reviewed. The consequence is that the pinned CLI only
// moves when a human moves it, and nothing used to say when it had fallen
// behind. 0.5.12 shipped a V0-only DSH parser for exactly that reason, months
// after upstream had added V0–V3 support.
//
// "latest channel" therefore does NOT mean "the release automatically uses the
// latest CLI". This script is the missing signal.
//
// Usage:
//   node scripts/verify-cli-upstream.mjs                 # report drift, exit 1 on drift
//   node scripts/verify-cli-upstream.mjs --check-only    # report, always exit 0
//   node scripts/verify-cli-upstream.mjs --offline       # skip every network lookup
//   node scripts/verify-cli-upstream.mjs --rebuild-verify
//                                                        # also re-run the vendoring
//                                                        # path and diff the result
//
// Environment:
//   VIBE_USAGE_UPSTREAM   upstream checkout used for snapshot provenance
//   VIBE_USAGE_REGISTRY   registry base URL (default https://registry.npmjs.org).
//                         A test seam: it lets the freshness comparison be
//                         exercised against a synthetic dist-tag while provenance
//                         stays pinned to a real, published artifact.
//
// Provenance and freshness are separate verdicts. "Is the snapshot authentic?" is
// answered by the exact pinned artifact plus the checked-in patches; "is a newer
// CLI out?" is a registry question. A new npm release therefore never turns a
// valid snapshot into a failed provenance check — it raises a freshness alarm.
//
// The rebuild deliberately resolves `@<pinned version>`, never the moving channel
// that scripts/vendor-cli.mjs defaults to. Rebuilding from the channel would only
// agree with the snapshot while the channel happens to equal the pin, which proves
// nothing about the next upstream release; it would also mean verifying the
// snapshot against code nobody reviewed.
//
// Nothing here writes to the repository and nothing re-vendors in place: the
// rebuild verification packs the pinned artifact into a temp dir and runs
// scripts/vendor-cli.mjs --from-local inside a throwaway mirror root, so the
// patches under test are the single implementation in this repository.
// Upgrading stays a reviewed change: run `node scripts/vendor-cli.mjs`, bump
// vibeUsageCliVersion, run the test suite, then bump the app version.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check-only");
const OFFLINE = args.has("--offline");
const REBUILD_VERIFY = args.has("--rebuild-verify");

const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const PACKAGE_NAME = "@vibe-cafe/vibe-usage";
const REGISTRY = process.env.VIBE_USAGE_REGISTRY?.trim().replace(/\/+$/, "") || "https://registry.npmjs.org";
const VENDORED_PARSER = "src-tauri/resources/cli/src/parsers/dsh.js";
const CLI_SNAPSHOT = "src-tauri/resources/cli";

// Provenance/compatibility problems: the checked-in snapshot cannot be trusted.
const problems = [];
// Upstream freshness only: the snapshot is fine, a newer reviewed CLI exists.
const drift = [];
const notes = [];

function problem(message) {
  problems.push(message);
}

function drifted(message) {
  drift.push(message);
}

function log(message) {
  console.log(`[verify-cli-upstream] ${message}`);
}

function compareVersions(a, b) {
  const pa = String(a).split("-")[0].split(".").map(Number);
  const pb = String(b).split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  // A prerelease sorts below its release.
  const preA = String(a).includes("-");
  const preB = String(b).includes("-");
  if (preA !== preB) return preA ? -1 : 1;
  return 0;
}

/** DSH session-format generation a dsh.js source tree can read. */
function dshFormatSupport(source) {
  const max = /MAX_SESSION_FORMAT_VERSION\s*=\s*(\d+)/.exec(source)?.[1];
  const exact = /SESSION_FORMAT_VERSION\s*=\s*(\d+)\s*;/.exec(source)?.[1];
  if (max !== undefined) return { max: Number(max), exact: false, filenameAddressed: /SESSION_FILENAME\s*=/.test(source) };
  if (exact !== undefined) return { max: Number(exact), exact: true, filenameAddressed: false };
  return { max: null, exact: false, filenameAddressed: false };
}

// ---------------------------------------------------------------------------
// 1. Local consistency: the pinned version and the snapshot must agree.

const app = readJson("package.json");
const pinned = app.vibeUsageCliVersion;
const channel = app.vibeUsageCliChannel;
const vendored = readJson(path.join(CLI_SNAPSHOT, "package.json")).version;

log(`app ${app.version}, channel ${channel}`);
log(`pinned CLI ${pinned}, vendored CLI ${vendored}`);

if (channel !== "latest") problem(`vibeUsageCliChannel must be latest, found ${channel}`);
if (pinned !== vendored) {
  problem(`vibeUsageCliVersion (${pinned}) does not match the vendored snapshot (${vendored})`);
}

// ---------------------------------------------------------------------------
// 2. Which reviewed upstream revision is the snapshot built from?

function upstreamCheckout() {
  for (const candidate of [process.env.VIBE_USAGE_UPSTREAM, path.join(root, "..", "vibe-usage")]) {
    if (candidate && fs.existsSync(path.join(candidate, ".git"))) return candidate;
  }
  return null;
}

function snapshotProvenance() {
  const upstream = upstreamCheckout();
  if (!upstream) {
    notes.push("no upstream checkout found — snapshot provenance not verified (set VIBE_USAGE_UPSTREAM)");
    return null;
  }
  const parser = read(VENDORED_PARSER).replace(/\r\n/g, "\n");
  let shas;
  try {
    shas = execFileSync("git", ["-C", upstream, "log", "--format=%H", "--", "src/parsers/dsh.js"],
      { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    notes.push(`cannot read git history from ${upstream} — snapshot provenance not verified`);
    return null;
  }
  for (const sha of shas) {
    let blob;
    try {
      blob = execFileSync("git", ["-C", upstream, "show", `${sha}:src/parsers/dsh.js`], { encoding: "utf8" });
    } catch {
      continue;
    }
    if (blob.replace(/\r\n/g, "\n") === parser) {
      const subject = execFileSync("git", ["-C", upstream, "log", "-1", "--format=%h %s", sha],
        { encoding: "utf8" }).trim();
      return { sha, subject };
    }
  }
  return { sha: null, subject: null };
}

const provenance = snapshotProvenance();
if (provenance?.sha) {
  log(`vendored DSH parser matches upstream ${provenance.subject}`);
} else if (provenance) {
  // The Windows patches never touch dsh.js, so a mismatch means either a
  // post-vendor hand edit or a snapshot taken from an uncommitted tree.
  problem("vendored DSH parser matches no upstream revision of src/parsers/dsh.js — was it edited by hand?");
}

// ---------------------------------------------------------------------------
// 3. Compatibility floor: the snapshot must read the DSH generation that ships today.

const MIN_DSH_FORMAT = 3; // DSH SESSION_FORMAT_VERSION as of dsh 0.1.5-rc
const vendoredSupport = dshFormatSupport(read(VENDORED_PARSER));
log(`vendored DSH parser reads format v0–v${vendoredSupport.max}` +
  `${vendoredSupport.exact ? " (exact-match only)" : ""}` +
  `${vendoredSupport.filenameAddressed ? "" : ", no versioned-filename addressing"}`);

if (vendoredSupport.max === null || vendoredSupport.max < MIN_DSH_FORMAT) {
  problem(`vendored DSH parser does not read DSH session format v${MIN_DSH_FORMAT}; ` +
    `users lose DeepSeek Harness usage until the CLI snapshot is upgraded`);
}
if (vendoredSupport.exact || !vendoredSupport.filenameAddressed) {
  problem("vendored DSH parser is not generation-aware: it will not enumerate session.vN.jsonl logs");
}

// ---------------------------------------------------------------------------
// 4. Registry drift: is a reviewed-but-newer CLI available?

let latest = null;
// Published digest of the *pinned* version, used by section 5 to prove the artifact
// it rebuilds from is the one the registry published — not merely one npm served.
let publishedDist = null;
if (!OFFLINE) {
  try {
    const res = await fetch(`${REGISTRY}/${PACKAGE_NAME.replace("/", "%2F")}`, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`GET ${REGISTRY} → ${res.status}`);
    const meta = await res.json();
    latest = meta["dist-tags"]?.latest ?? null;
    publishedDist = meta.versions?.[pinned]?.dist ?? null;
    log(`registry latest ${latest}`);
    if (!publishedDist) {
      notes.push(`registry metadata carries no dist entry for ${pinned} — artifact digest not checked`);
    }
    if (latest && compareVersions(latest, pinned) > 0) {
      drifted(`a newer ${PACKAGE_NAME} is published: ${latest} (pinned ${pinned}). ` +
        `Upgrade with: node scripts/vendor-cli.mjs && bump vibeUsageCliVersion, ` +
        `run the test suite, then bump the app version.`);
    }
  } catch (error) {
    notes.push(`registry lookup failed (${error.message}) — drift not checked`);
  }
} else {
  notes.push("--offline: registry drift not checked");
}

// ---------------------------------------------------------------------------
// 5. Deterministic rebuild (--rebuild-verify): the snapshot must be reproducible
//    from the exact pinned official artifact plus the checked-in Windows patches.
//
//    This is the invariant that actually matters, and it is deliberately not
//    "vendored tree == raw upstream tree": the snapshot is upstream *plus* the
//    patches in scripts/vendor-cli.mjs, so that comparison would always fail.
//    Section 2 only proves one unpatched file (dsh.js) is authentic; this section
//    proves the whole tree is what the vendoring path produces.
//
//    Two properties keep this an honest check:
//      * the artifact is fetched as `@<pinned version>`. Resolving the moving
//        channel instead would make the comparison true only while the channel
//        happens to equal the pin, and would verify the snapshot against
//        unreviewed code.
//      * the patches are applied by scripts/vendor-cli.mjs itself, invoked with
//        --from-local against the unpacked artifact inside a throwaway mirror
//        root. There is exactly one patch implementation, which is also why this
//        file never duplicates patch logic.
//
//    A freshness alarm is therefore not a provenance failure: nothing here reads
//    dist-tags.latest.

function walkTree(dir, rel = "") {
  const files = new Map();
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs)) return files;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [k, v] of walkTree(dir, r)) files.set(k, v);
    else files.set(r, fs.readFileSync(path.join(dir, r)));
  }
  return files;
}

/** Compare two CLI trees. Line endings are normalised: git may rewrite EOL. */
/**
 * `.vibe-usage-source.json` records *how* the snapshot was produced (channel vs
 * `--from-local`, and the source commit). The rebuild path always vendors with
 * `--from-local` from an unpacked tarball, so its `source` can never equal a
 * snapshot vendored from the registry — comparing it byte for byte made every
 * rebuild report "not reproducible", which is a failure that never clears and
 * therefore stops meaning anything. The pin it could disagree about (the
 * version) is already checked against `identity.version` above.
 */
const PROVENANCE_FILE = ".vibe-usage-source.json";

function compareTrees(rebuiltDir, checkedInDir) {
  const norm = (b) => b.toString("utf8").replace(/\r\n/g, "\n");
  const a = walkTree(rebuiltDir);
  const b = walkTree(checkedInDir);
  a.delete(PROVENANCE_FILE);
  b.delete(PROVENANCE_FILE);
  const missing = [...a.keys()].filter((k) => !b.has(k)).sort();
  const extra = [...b.keys()].filter((k) => !a.has(k)).sort();
  const differing = [...a.keys()]
    .filter((k) => b.has(k) && norm(a.get(k)) !== norm(b.get(k)))
    .sort();
  return { count: a.size, missing, extra, differing };
}

/** Download and unpack exactly `@<pinned>`. The channel is never consulted. */
function packPinnedArtifact(dest) {
  fs.mkdirSync(dest, { recursive: true });
  const out = execFileSync("npm", ["pack", `${PACKAGE_NAME}@${pinned}`, "--pack-destination", dest],
    { encoding: "utf8", shell: process.platform === "win32" }).trim();
  const tarball = path.join(dest, out.split("\n").pop().trim());
  execFileSync("tar", ["-xzf", tarball, "-C", dest], { stdio: "ignore" });
  return { tarball, packageDir: path.join(dest, "package") };
}

/**
 * The packed tarball must be the artifact the registry published, otherwise
 * "official npm artifact" is an assumption rather than a checked fact.
 * Returns false when a digest was available and mismatched.
 */
function verifyArtifactDigest(tarball) {
  const bytes = fs.readFileSync(tarball);
  const expected = publishedDist?.integrity;
  if (expected) {
    const actual = `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== expected) {
      problem(`the artifact npm packed for ${PACKAGE_NAME}@${pinned} does not match the published ` +
        `dist.integrity (published ${expected}, packed ${actual})`);
      return false;
    }
    log("packed artifact matches the published dist.integrity");
    return true;
  }
  const shasum = publishedDist?.shasum;
  if (shasum) {
    const actual = crypto.createHash("sha1").update(bytes).digest("hex");
    if (actual !== shasum) {
      problem(`the artifact npm packed for ${PACKAGE_NAME}@${pinned} does not match the published ` +
        `sha1 (published ${shasum}, packed ${actual})`);
      return false;
    }
    log("packed artifact matches the published sha1 (this release publishes no sha512)");
    return true;
  }
  notes.push(`no published digest for ${PACKAGE_NAME}@${pinned} — packed artifact not authenticated`);
  return null;
}

function tailOf(error) {
  const detail = `${error.stdout ?? ""}${error.stderr ?? ""}${error.message ?? ""}`.trim();
  return { detail, last: detail.split("\n").filter(Boolean).slice(-1)[0] ?? "unknown error" };
}

async function verifyDeterministicRebuild() {
  if (!REBUILD_VERIFY) {
    notes.push("deterministic rebuild not verified (pass --rebuild-verify)");
    return;
  }
  if (OFFLINE) {
    notes.push("--offline: deterministic rebuild not verified");
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cli-rebuild-"));
  try {
    fs.mkdirSync(path.join(tmp, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "src-tauri", "resources"), { recursive: true });
    fs.copyFileSync(path.join(root, "scripts", "vendor-cli.mjs"),
      path.join(tmp, "scripts", "vendor-cli.mjs"));
    fs.copyFileSync(path.join(root, "package.json"), path.join(tmp, "package.json"));

    log(`fetching the exact pin ${PACKAGE_NAME}@${pinned} — dist-tags.latest is not consulted`);
    let artifact;
    try {
      artifact = packPinnedArtifact(path.join(tmp, "pinned"));
    } catch (error) {
      const { detail, last } = tailOf(error);
      // An unpublished pin is a provenance problem: the snapshot claims an origin
      // that does not exist. An unreachable registry or a missing npm is an
      // environment limit, and an environment limit must not be reported as a
      // failed snapshot.
      if (/\bE404\b|404 Not Found/.test(detail)) {
        problem(`pinned ${PACKAGE_NAME}@${pinned} is not published on ${REGISTRY}: ${last}`);
      } else {
        notes.push(`deterministic rebuild skipped — ${PACKAGE_NAME}@${pinned} could not be fetched (${last})`);
      }
      return;
    }

    if (verifyArtifactDigest(artifact.tarball) === false) return;

    try {
      execFileSync(process.execPath,
        [path.join(tmp, "scripts", "vendor-cli.mjs"), "--from-local", artifact.packageDir],
        { encoding: "utf8", cwd: tmp, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      const { detail, last } = tailOf(error);
      // A missing patch anchor is a real finding: the checked-in snapshot could
      // not have been produced by the patches that are supposed to define it.
      // Anything else (temp dir unwritable, npm invocation broken) is an
      // environment limit.
      if (/patch anchor missing|invalid vendored CLI identity|local checkout missing/.test(detail)) {
        problem(`deterministic rebuild failed: ${last}`);
      } else {
        notes.push(`deterministic rebuild skipped — vendoring path could not run (${last})`);
      }
      return;
    }

    const rebuiltDir = path.join(tmp, "src-tauri", "resources", "cli");
    const identity = JSON.parse(fs.readFileSync(path.join(rebuiltDir, "package.json"), "utf8"));
    log(`vendoring path rebuilt ${identity.name}@${identity.version} from the pinned artifact`);

    if (identity.name !== PACKAGE_NAME) {
      problem(`rebuilt snapshot identity is ${identity.name}, expected ${PACKAGE_NAME}`);
      return;
    }
    if (identity.version !== pinned) {
      // The artifact was fetched by exact version, so a newer upstream release
      // cannot explain this: the pin does not describe the tree being rebuilt.
      problem(`rebuilding from the pinned artifact produced ${identity.version}, not the pinned ${pinned}`);
      return;
    }

    const diff = compareTrees(rebuiltDir, path.join(root, CLI_SNAPSHOT));
    if (diff.missing.length || diff.extra.length || diff.differing.length) {
      problem(`checked-in snapshot is not reproducible from ${PACKAGE_NAME}@${pinned} + ` +
        `scripts/vendor-cli.mjs: ${diff.missing.length} missing, ${diff.extra.length} extra, ` +
        `${diff.differing.length} differing` +
        (diff.missing.length ? ` (missing: ${diff.missing.slice(0, 5).join(", ")})` : "") +
        (diff.extra.length ? ` (extra: ${diff.extra.slice(0, 5).join(", ")})` : "") +
        (diff.differing.length ? ` (differs: ${diff.differing.slice(0, 5).join(", ")})` : ""));
      return;
    }
    log(`deterministic rebuild reproduces all ${diff.count} snapshot files byte for byte`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await verifyDeterministicRebuild();

// ---------------------------------------------------------------------------

for (const note of notes) log(`note: ${note}`);

const provenanceOk = problems.length === 0;
console.log(`[verify-cli-upstream] PROVENANCE: ${provenanceOk ? "PASS" : "FAIL"} ` +
  `(pinned ${pinned} is authentic and reads DSH format v${MIN_DSH_FORMAT}+)`);
console.log(`[verify-cli-upstream] FRESHNESS:  ` +
  (drift.length === 0 ? "pinned CLI is current" : `${drift.length} newer release(s) available`));

if (provenanceOk && drift.length === 0) {
  process.exit(0);
}

if (drift.length > 0) {
  console.error("\n[verify-cli-upstream] freshness — the pinned snapshot itself remains valid:");
  for (const d of drift) console.error(`  ! ${d}`);
}
if (problems.length > 0) {
  console.error(`\n[verify-cli-upstream] provenance/compatibility — ${problems.length} issue(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
}
if (CHECK_ONLY) {
  console.error("\n[verify-cli-upstream] --check-only: reporting without failing");
  process.exit(0);
}
process.exit(1);

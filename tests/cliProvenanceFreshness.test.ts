import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Regression coverage for the provenance/freshness split in
 * `scripts/verify-cli-upstream.mjs --rebuild-verify`.
 *
 * The invariant this file protects:
 *
 *     rebuild(official npm artifact @ the EXACT pinned version + Windows patches)
 *       == checked-in snapshot
 *
 * and the failure mode it exists for: a rebuild that resolves the moving npm
 * channel. `vibeUsageCliVersion` is a pin, but `vibeUsageCliChannel` is
 * `"latest"`, so a verifier that packs `@latest` compares the snapshot against
 * whatever upstream published most recently. Such a check passes only while the
 * channel happens to equal the pin, and once it starts failing it fails for a
 * reason that has nothing to do with this repository.
 *
 * A real "pinned behind latest" state cannot be staged from the public registry —
 * publishing a version is not something a test may do — so the registry is
 * simulated. Everything else stays real: the real repository, the real artifact
 * at the real pin, its real published digest, the real patch implementation in
 * scripts/vendor-cli.mjs, and the real snapshot.
 *
 * Opt-in: set VIBE_USAGE_PROVENANCE_SIM=1. The suite needs the public registry
 * (to learn the authentic artifact and its digest) plus `npm` and `tar` on PATH,
 * so it is not part of an automated run.
 */

const SIM = process.env.VIBE_USAGE_PROVENANCE_SIM?.trim() === "1";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PUBLIC_REGISTRY = "https://registry.npmjs.org";
const PACKAGE_NAME = "@vibe-cafe/vibe-usage";

const VERIFY = join(REPO_ROOT, "scripts", "verify-cli-upstream.mjs");
const VENDOR = join(REPO_ROOT, "scripts", "vendor-cli.mjs");
const SNAPSHOT_REL = join("src-tauri", "resources", "cli");

const appPackage = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  vibeUsageCliVersion: string;
};
const PIN = appPackage.vibeUsageCliVersion;

/** A version strictly above the pin: the simulated upstream release. */
function bumped(version: string): string {
  const [major, minor, patch] = version.split("-")[0].split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}
const NEWER = bumped(PIN);

interface Dist {
  tarball: string;
  integrity?: string;
  shasum?: string;
}
interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, { name: string; version: string; dist: Dist }>;
}

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha512(bytes: Buffer): string {
  return `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}`;
}

function run(command: string, args: string[], cwd?: string): string {
  const proc = spawnSync(command, args, { encoding: "utf8", cwd });
  if (proc.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${proc.status}: ${proc.stderr || proc.stdout}`);
  }
  return `${proc.stdout ?? ""}`;
}

/**
 * Repack the authentic artifact with a bumped version, so the simulated newer
 * release is a genuinely installable, genuinely patchable tree rather than a
 * corrupt download. A corrupt tarball would make the verifier skip the rebuild
 * (it treats an extraction failure as an environment limit) instead of comparing
 * it, which would make the last test in this file vacuous.
 */
function repackWithVersion(source: Buffer, version: string): Buffer {
  const work = tempDir("vibe-prov-repack-");
  const tarball = join(work, "source.tgz");
  writeFileSync(tarball, source);
  run("tar", ["-xzf", tarball, "-C", work]);
  const pkgPath = join(work, "package", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const out = join(work, `${version}.tgz`);
  run("tar", ["-czf", out, "-C", join(work, "package"), "."]);
  return readFileSync(out);
}

let server: http.Server | null = null;
let origin = "";
let packument: Packument | null = null;
/** Which `dist-tags.latest` the simulated registry reports. */
let publishedLatest = PIN;
/** Bumped only so the isolation check below cannot silently compare equal. */
let servedTarballs = 0;
const tarballs = new Map<string, Buffer>();

/** A minimal npm registry: one packument route and one tarball route. */
function startRegistry(): Promise<void> {
  server = http.createServer((req, res) => {
    const route = decodeURIComponent((req.url ?? "").split("?")[0]);
    if (/\/@vibe-cafe\/vibe-usage\/?$/i.test(route) && packument) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...packument, "dist-tags": { ...packument["dist-tags"], latest: publishedLatest } }));
      return;
    }
    const match = route.match(/\/(vibe-usage-[\d.]+\.tgz)$/i);
    const bytes = match ? tarballs.get(match[1]) : undefined;
    if (bytes) {
      servedTarballs += 1;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytes);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  return new Promise((settle) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      const port = typeof address === "object" && address ? address.port : 0;
      origin = `http://127.0.0.1:${port}/`;
      settle();
    });
  });
}

/**
 * Run the verifier with both its metadata and npm pointed at the fake registry.
 *
 * Asynchronous on purpose: the simulated registry lives in this process, so a
 * synchronous spawn would block the event loop and deadlock against its own npm
 * child, which is waiting for a response that can no longer be written.
 */
function runVerifier(script: string, cwd: string): Promise<{ status: number | null; output: string }> {
  return new Promise((settle) => {
    // The pin has to travel over the wire for "served exactly once" to mean
    // anything, and a warm npm cache serves it without a request: the drift job
    // runs a real-registry `--rebuild-verify` first, and on Windows that entry
    // satisfied this child too, so the served-tarball count stayed 0 while the
    // verifier itself was correct. One throwaway cache per child keeps the check
    // deterministic on every OS.
    const cacheDir = mkdtempSync(join(tmpdir(), "vibe-cli-npm-cache-"));
    const child = spawn(process.execPath, [script, "--rebuild-verify"], {
      cwd,
      env: {
        ...process.env,
        VIBE_USAGE_REGISTRY: origin,
        // npm resolves the exact pin *and* `@latest` against this, so a verifier
        // that consults the channel really does receive the newer release.
        npm_config_registry: origin,
        npm_config_cache: cacheDir,
        // No project or user npmrc may redirect the request elsewhere.
        NPM_CONFIG_USERCONFIG: join(cwd, "npmrc-that-does-not-exist"),
      },
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("close", (status) => {
      rmSync(cacheDir, { recursive: true, force: true });
      settle({ status, output });
    });
  });
}

describe.skipIf(!SIM)(
  "CLI provenance follows the vendored pin, not the npm channel " +
    "(opt-in: VIBE_USAGE_PROVENANCE_SIM=1)",
  () => {
    beforeAll(async () => {
      const res = await fetch(`${PUBLIC_REGISTRY}/@vibe-cafe%2Fvibe-usage`, {
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`registry lookup failed: ${res.status}`);
      const published = (await res.json()) as Packument;

      const pinnedMeta = published.versions[PIN];
      if (!pinnedMeta?.dist?.tarball) throw new Error(`no published metadata for ${PIN}`);
      const download = await fetch(pinnedMeta.dist.tarball, { signal: AbortSignal.timeout(30_000) });
      if (!download.ok) throw new Error(`artifact download failed: ${download.status}`);
      const authentic = Buffer.from(await download.arrayBuffer());
      if (pinnedMeta.dist.integrity && sha512(authentic) !== pinnedMeta.dist.integrity) {
        throw new Error("the artifact this suite downloaded is not the published one");
      }

      await startRegistry();

      const newer = repackWithVersion(authentic, NEWER);
      tarballs.set(`vibe-usage-${PIN}.tgz`, authentic);
      tarballs.set(`vibe-usage-${NEWER}.tgz`, newer);

      packument = {
        ...published,
        versions: {
          ...published.versions,
          [PIN]: {
            ...pinnedMeta,
            dist: { ...pinnedMeta.dist, tarball: `${origin}vibe-usage-${PIN}.tgz` },
          },
          [NEWER]: {
            name: PACKAGE_NAME,
            version: NEWER,
            dist: { tarball: `${origin}vibe-usage-${NEWER}.tgz`, integrity: sha512(newer) },
          },
        },
      };
    }, 180_000);

    afterAll(async () => {
      if (server) await new Promise<void>((settle) => server!.close(() => settle()));
      while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    });

    it("reports PASS for the exact pin while a newer release is published", async () => {
      publishedLatest = NEWER;
      const before = servedTarballs;
      const { status, output } = await runVerifier(VERIFY, REPO_ROOT);

      expect(output).toContain(`fetching the exact pin ${PACKAGE_NAME}@${PIN}`);
      expect(output).toContain("deterministic rebuild reproduces all");
      expect(output).toContain("PROVENANCE: PASS");
      expect(output).not.toContain("PROVENANCE: FAIL");
      // The alarm is still raised, and it is the only reason the run fails.
      expect(output).toMatch(/FRESHNESS:\s+1 newer release\(s\) available/);
      expect(status).toBe(1);
      // The pinned tarball was served; the simulated newer one was never fetched.
      expect(servedTarballs).toBe(before + 1);
    }, 300_000);

    it("reports PASS and no drift when the pin is the published latest", async () => {
      publishedLatest = PIN;
      const { status, output } = await runVerifier(VERIFY, REPO_ROOT);

      expect(output).toContain("PROVENANCE: PASS");
      expect(output).toContain("FRESHNESS:  pinned CLI is current");
      expect(status).toBe(0);
    }, 300_000);

    it("would report FAIL if the rebuild resolved the channel instead of the pin", async () => {
      // Mirror the repository and mutate only the artifact request, so the
      // assertions above are shown to discriminate rather than to always pass.
      const mirror = tempDir("vibe-prov-mirror-");
      mkdirSync(join(mirror, "scripts"), { recursive: true });
      mkdirSync(join(mirror, "src-tauri", "resources"), { recursive: true });
      cpSync(join(REPO_ROOT, "package.json"), join(mirror, "package.json"));
      cpSync(VENDOR, join(mirror, "scripts", "vendor-cli.mjs"));
      cpSync(join(REPO_ROOT, SNAPSHOT_REL), join(mirror, SNAPSHOT_REL), { recursive: true });

      const source = readFileSync(VERIFY, "utf8");
      const target = "`${PACKAGE_NAME}@${pinned}`";
      expect(source, "the exact-pin request must still be present to mutate").toContain(target);
      const mutated = source.replace(target, "`${PACKAGE_NAME}@latest`");
      expect(mutated).not.toBe(source);
      const mutatedPath = join(mirror, "scripts", "verify-cli-upstream.mjs");
      writeFileSync(mutatedPath, mutated);

      publishedLatest = NEWER;
      const { output } = await runVerifier(mutatedPath, mirror);

      expect(output).toContain("PROVENANCE: FAIL");
    }, 300_000);
  },
);

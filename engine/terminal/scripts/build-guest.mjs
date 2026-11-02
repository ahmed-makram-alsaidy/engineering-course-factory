// P5.1 guest build: bundle the supervisor to plain JS for the pinned Node 24
// guest runtime. Output: container/dist/supervisor.mjs (git-ignored build
// artifact; the image COPY consumes it). The bundle is self-contained — its
// only external imports must be `node:` builtins — and is verified here so a
// bad dependency can never reach the image silently.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const outfile = path.join(packageRoot, "container", "dist", "supervisor.mjs");

await build({
  entryPoints: [path.join(packageRoot, "container", "supervisor.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  minify: false,
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
});

const code = readFileSync(outfile, "utf8");
const bytes = statSync(outfile).size;

// Every module specifier in the bundle must be a node: builtin (fully bundled
// otherwise). Reject forbidden constructs outright.
//
// P5.5 amendment (documented in docs/P5-IMPLEMENTATION.md): the P5.1 scaffold
// asserted "the guest supervisor never spawns processes". P5.5 makes the
// container entrypoint the ONE sanctioned process-creation site (design
// "Transport": the supervisor spawns /bin/sh -c <authored command>, detached,
// as its own process group). The bundle therefore REQUIRES node:child_process
// while network machinery (net/http/dns/tls), the Docker SDK and node-pty
// remain forbidden, and `exec`/`execFile` string transport stays forbidden.
const specifiers = new Set();
for (const match of code.matchAll(/from\s*"([^"]+)"/g)) specifiers.add(match[1]);
for (const match of code.matchAll(/import\s*\(\s*"([^"]+)"\s*\)/g)) specifiers.add(match[1]);
const nonBuiltin = [...specifiers].filter((s) => !s.startsWith("node:"));
const forbidden = [];
for (const pattern of ["node-pty", "dockerode", "node:net", "node:http", "node:https", "node:dns", "node:tls", "node:fs"]) {
  if (specifiers.has(pattern)) forbidden.push(pattern);
}
if (!specifiers.has("node:child_process")) forbidden.push("missing required node:child_process (P5.5 supervisor spawn)");
if (/\bexec\s*\(|\bexecFile\s*\(|\bfork\s*\(/.test(code)) forbidden.push("string/fork transport");
if (!/spawn\("\/bin\/sh",\s*\["-c",/.test(code)) forbidden.push("guest spawn must be /bin/sh -c (one argv element)");

if (nonBuiltin.length > 0 || forbidden.length > 0) {
  console.error("GUEST_BUILD_REJECTED");
  if (nonBuiltin.length > 0) console.error("  non-builtin imports: " + nonBuiltin.join(", "));
  if (forbidden.length > 0) console.error("  forbidden constructs: " + forbidden.join(", "));
  process.exit(1);
}

if (bytes > 2 * 1024 * 1024) {
  console.error("GUEST_BUILD_REJECTED: bundle exceeds 2 MiB (" + bytes + " bytes)");
  process.exit(1);
}

const sha256 = createHash("sha256").update(code).digest("hex");
console.log(
  "GUEST_BUILD " +
    JSON.stringify({
      outfile: "container/dist/supervisor.mjs",
      bytes,
      sha256,
      imports: [...specifiers].sort(),
      target: "node24",
      format: "esm",
    }),
);

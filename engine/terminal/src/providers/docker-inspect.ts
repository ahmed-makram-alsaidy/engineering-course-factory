// P5.4 pure container-configuration verifier. Turns a raw `docker inspect`
// JSON document into a list of concrete policy violations (problems); an
// empty list means the created container matches the canonical sandbox
// policy exactly. No I/O: the provider feeds inspect output here and only
// starts a container whose configuration verifies against the design
// "Container Security Policy". Expected values come from SANDBOX_POLICY.

import { SANDBOX_POLICY } from "./docker-policy.ts";

export interface InspectExpectations {
  readonly mountSource: string;
  readonly imageReference: string;
  readonly bridge?: {
    readonly networkName: string;
    readonly hostPort: number;
    readonly guestPort: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

const FORBIDDEN_ENV_FRAGMENTS = Object.freeze([
  "KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL",
  "AWS_", "AZURE_", "GCP_", "GITHUB", "DOCKER_",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
] as readonly string[]);

export function verifyContainerConfiguration(
  inspectJson: unknown,
  expectations: InspectExpectations,
): readonly string[] {
  const problems: string[] = [];
  const raw = Array.isArray(inspectJson) ? inspectJson[0] : inspectJson;
  const root = asRecord(raw);
  const config = asRecord(root === null ? null : root["Config"]);
  const hostConfig = asRecord(root === null ? null : root["HostConfig"]);
  const mounts = root === null ? [] : (Array.isArray(root["Mounts"]) ? (root["Mounts"] as unknown[]) : []);

  if (config === null) {
    problems.push("inspect document has no Config object");
    return Object.freeze(problems);
  }
  if (hostConfig === null) {
    problems.push("inspect document has no HostConfig object");
  }

  const imageField = typeof config["Image"] === "string" ? (config["Image"] as string) : "";
  if (imageField === "") {
    problems.push("container image is empty");
  } else if (imageField === expectations.imageReference) {
    // Exact digest-pinned match — the expected case.
  } else if (!imageField.includes("@sha256:") && !/^sha256:[0-9a-f]{64}$/.test(imageField)) {
    problems.push(`container image is not digest-pinned: ${imageField}`);
  } else {
    problems.push(`container image ${imageField} does not match trusted reference ${expectations.imageReference}`);
  }

  if (config["User"] !== SANDBOX_POLICY.container.user) {
    problems.push(`guest user is "${String(config["User"])}" (expected ${SANDBOX_POLICY.container.user})`);
  }
  if (config["WorkingDir"] !== SANDBOX_POLICY.mount.container_target) {
    problems.push(`container WorkingDir is "${String(config["WorkingDir"])}" (expected /workspace)`);
  }

  if (hostConfig !== null) {
    if (hostConfig["Privileged"] === true) problems.push("Privileged is true");
    if (expectations.bridge !== undefined) {
      const networkMode = hostConfig["NetworkMode"];
      if (networkMode !== expectations.bridge.networkName) {
        problems.push(`NetworkMode is "${String(networkMode)}" (expected bridge ${expectations.bridge.networkName})`);
      }
      const portBindings = asRecord(hostConfig["PortBindings"]);
      const expectedPortKey = `${expectations.bridge.guestPort}/tcp`;
      if (portBindings === null) {
        problems.push("PortBindings is missing");
      } else {
        const keys = Object.keys(portBindings);
        if (keys.length !== 1 || keys[0] !== expectedPortKey) {
          problems.push(`published ports mismatch: expected [${expectedPortKey}], found [${keys.join(",")}]`);
        } else {
          const bindingList = Array.isArray(portBindings[expectedPortKey]) ? (portBindings[expectedPortKey] as unknown[]) : [];
          if (bindingList.length !== 1) {
            problems.push(`expected exactly one binding for ${expectedPortKey}`);
          } else {
            const b = asRecord(bindingList[0]);
            if (b === null || b["HostIp"] !== "127.0.0.1" || b["HostPort"] !== String(expectations.bridge.hostPort)) {
              problems.push(`port binding HostIp/HostPort is not 127.0.0.1:${expectations.bridge.hostPort}`);
            }
          }
        }
      }
      const dns = Array.isArray(hostConfig["Dns"]) ? (hostConfig["Dns"] as string[]) : [];
      if (!dns.includes("127.0.0.1")) {
        problems.push("DNS is not restricted to 127.0.0.1");
      }
    } else {
      const networkMode = hostConfig["NetworkMode"];
      if (networkMode !== SANDBOX_POLICY.container.network) problems.push(`NetworkMode is "${String(networkMode)}" (expected none)`);
      const portBindings = hostConfig["PortBindings"];
      if (portBindings !== null && portBindings !== undefined) {
        const keys = typeof portBindings === "object" ? Object.keys(portBindings as object) : [];
        if (keys.length > 0) problems.push(`published ports present: ${keys.join(",")}`);
      }
      const exposed = config["ExposedPorts"];
      if (exposed !== null && exposed !== undefined && typeof exposed === "object" && Object.keys(exposed as object).length > 0) {
        problems.push("container declares exposed ports");
      }
    }
    const capDrop = Array.isArray(hostConfig["CapDrop"]) ? (hostConfig["CapDrop"] as string[]) : [];
    if (!capDrop.includes(SANDBOX_POLICY.container.cap_drop)) problems.push("CapDrop does not include ALL");
    const securityOpt = Array.isArray(hostConfig["SecurityOpt"]) ? (hostConfig["SecurityOpt"] as string[]) : [];
    if (!securityOpt.includes(SANDBOX_POLICY.container.security_opt)) problems.push("SecurityOpt does not include no-new-privileges=true");
    if (hostConfig["ReadonlyRootfs"] !== true) problems.push("ReadonlyRootfs is not true");
    if (hostConfig["PidsLimit"] !== SANDBOX_POLICY.container.pids_limit) problems.push("PidsLimit does not match policy");
    if (hostConfig["Memory"] !== SANDBOX_POLICY.bytes.memory) problems.push("Memory limit does not match policy");
    if (hostConfig["MemorySwap"] !== SANDBOX_POLICY.bytes.memory_swap) problems.push("MemorySwap limit does not match policy");
    if (hostConfig["NanoCpus"] !== SANDBOX_POLICY.bytes.nano_cpus) problems.push("NanoCpus limit does not match policy");
    if (hostConfig["ShmSize"] !== SANDBOX_POLICY.bytes.shm_size) problems.push("ShmSize does not match policy");
    const tmpfs = asRecord(hostConfig["Tmpfs"]);
    if (tmpfs === null || tmpfs[SANDBOX_POLICY.container.tmpfs_target] !== SANDBOX_POLICY.container.tmpfs_options) problems.push("/tmp tmpfs policy does not match");
    if (hostConfig["Init"] !== true) problems.push("docker-init is not enabled");
    const restart = asRecord(hostConfig["RestartPolicy"]);
    if (restart === null || restart["Name"] !== SANDBOX_POLICY.container.restart) problems.push("restart policy is not correct");
    if (hostConfig["IpcMode"] !== SANDBOX_POLICY.container.ipc) problems.push("IpcMode is not private");
    const pidMode = hostConfig["PidMode"];
    if (pidMode !== "" && pidMode !== "private") problems.push("PidMode is not private/unset");
  }

  const writableBinds = mounts.filter((mount) => {
    const m = asRecord(mount);
    return m !== null && m["Type"] === "bind" && m["RW"] === true;
  });
  if (writableBinds.length !== 1) {
    problems.push(`expected exactly one writable bind, found ${writableBinds.length}`);
  } else {
    const m = asRecord(writableBinds[0]);
    if (m === null || m["Source"] !== expectations.mountSource || m["Destination"] !== SANDBOX_POLICY.mount.container_target) {
      problems.push("writable bind is not <trusted leaf> -> /workspace");
    }
  }
  for (const mount of mounts) {
    const m = asRecord(mount);
    if (m === null) continue;
    const destination = typeof m["Destination"] === "string" ? (m["Destination"] as string) : "";
    const source = typeof m["Source"] === "string" ? (m["Source"] as string) : "";
    if (destination.includes("/docker.sock") || source.toLowerCase().includes("\\docker.sock")) {
      problems.push("Docker socket mount detected");
    }
  }

  const env = Array.isArray(config["Env"]) ? (config["Env"] as string[]) : [];
  for (const entry of env) {
    const name = entry.split("=", 1)[0].toUpperCase();
    if (FORBIDDEN_ENV_FRAGMENTS.some((fragment) => name.includes(fragment))) {
      problems.push(`container env carries forbidden variable name "${name}"`);
    }
  }

  return Object.freeze(problems);
}

// ---------------------------------------------------------------------------
// P6.3 access-epoch verifier (additive; the P5 verifier above is unchanged
// for legacy terminal-only sessions).
//
// Canonical authority: docs/P6-DESIGN-SPEC.md sections 26.3/26.9 and
// docs/adr/ADR-0011-shared-workspace-ownership.md decisions 2-3. The ONLY
// intended difference from the legacy sandbox is the workspace bind access:
// a read_only epoch must present the leaf at /workspace with RW == false
// (Docker-enforced guest write boundary), a read_write epoch with RW ==
// true. Every other P5 sandbox invariant is re-checked unchanged, plus the
// combined-epoch scratch profile (HOME/TMP/cache under /tmp, never under
// the possibly read-only /workspace) and the P6 epoch ownership labels.
// ---------------------------------------------------------------------------

export interface EpochInspectExpectations {
  readonly mountSource: string;
  readonly imageReference: string;
  readonly access: "read_only" | "read_write";
  readonly installationId: string;
  readonly sessionId: string;
}

/** Fixed combined-epoch scratch values (mirrors workspace-epochs.ts; compared by value, never imported across the boundary). */
const EPOCH_SCRATCH_ENV_EXPECTED: Readonly<Record<string, string>> = Object.freeze({
  HOME: "/tmp/cf-home",
  TMPDIR: "/tmp/cf-tmp",
  XDG_CACHE_HOME: "/tmp/cf-cache",
  LANG: "C.UTF-8",
});

export function verifyEpochContainerConfiguration(
  inspectJson: unknown,
  expectations: EpochInspectExpectations,
): readonly string[] {
  const problems: string[] = [];
  const raw = Array.isArray(inspectJson) ? inspectJson[0] : inspectJson;
  const root = asRecord(raw);
  const config = asRecord(root === null ? null : root["Config"]);
  const hostConfig = asRecord(root === null ? null : root["HostConfig"]);
  const mounts = root === null ? [] : (Array.isArray(root["Mounts"]) ? (root["Mounts"] as unknown[]) : []);

  if (config === null) {
    problems.push("inspect document has no Config object");
    return Object.freeze(problems);
  }
  if (hostConfig === null) {
    problems.push("inspect document has no HostConfig object");
  }

  const imageField = typeof config["Image"] === "string" ? (config["Image"] as string) : "";
  if (imageField === "") {
    problems.push("container image is empty");
  } else if (imageField === expectations.imageReference) {
    // Exact digest-pinned match — the expected case.
  } else if (!imageField.includes("@sha256:") && !/^sha256:[0-9a-f]{64}$/.test(imageField)) {
    problems.push(`container image is not digest-pinned: ${imageField}`);
  } else {
    problems.push(`container image ${imageField} does not match trusted reference ${expectations.imageReference}`);
  }

  if (config["User"] !== SANDBOX_POLICY.container.user) {
    problems.push(`guest user is "${String(config["User"])}" (expected ${SANDBOX_POLICY.container.user})`);
  }
  if (config["WorkingDir"] !== SANDBOX_POLICY.mount.container_target) {
    problems.push(`container WorkingDir is "${String(config["WorkingDir"])}" (expected /workspace)`);
  }

  if (hostConfig !== null) {
    if (hostConfig["Privileged"] === true) problems.push("Privileged is true");
    const networkMode = hostConfig["NetworkMode"];
    if (networkMode !== SANDBOX_POLICY.container.network) problems.push(`NetworkMode is "${String(networkMode)}" (expected none)`);
    const capDrop = Array.isArray(hostConfig["CapDrop"]) ? (hostConfig["CapDrop"] as string[]) : [];
    if (!capDrop.includes(SANDBOX_POLICY.container.cap_drop)) problems.push("CapDrop does not include ALL");
    const securityOpt = Array.isArray(hostConfig["SecurityOpt"]) ? (hostConfig["SecurityOpt"] as string[]) : [];
    if (!securityOpt.includes(SANDBOX_POLICY.container.security_opt)) problems.push("SecurityOpt does not include no-new-privileges=true");
    if (hostConfig["ReadonlyRootfs"] !== true) problems.push("ReadonlyRootfs is not true");
    if (hostConfig["PidsLimit"] !== SANDBOX_POLICY.container.pids_limit) problems.push("PidsLimit does not match policy");
    if (hostConfig["Memory"] !== SANDBOX_POLICY.bytes.memory) problems.push("Memory limit does not match policy");
    if (hostConfig["MemorySwap"] !== SANDBOX_POLICY.bytes.memory_swap) problems.push("MemorySwap limit does not match policy");
    if (hostConfig["NanoCpus"] !== SANDBOX_POLICY.bytes.nano_cpus) problems.push("NanoCpus limit does not match policy");
    if (hostConfig["ShmSize"] !== SANDBOX_POLICY.bytes.shm_size) problems.push("ShmSize does not match policy");
    const tmpfs = asRecord(hostConfig["Tmpfs"]);
    if (tmpfs === null || tmpfs[SANDBOX_POLICY.container.tmpfs_target] !== SANDBOX_POLICY.container.tmpfs_options) problems.push("/tmp tmpfs policy does not match");
    if (hostConfig["Init"] !== true) problems.push("docker-init is not enabled");
    const restart = asRecord(hostConfig["RestartPolicy"]);
    if (restart === null || restart["Name"] !== SANDBOX_POLICY.container.restart) problems.push("restart policy is not correct");
    if (hostConfig["IpcMode"] !== SANDBOX_POLICY.container.ipc) problems.push("IpcMode is not private");
    const pidMode = hostConfig["PidMode"];
    if (pidMode !== "" && pidMode !== "private") problems.push("PidMode is not private/unset");
    const portBindings = hostConfig["PortBindings"];
    if (portBindings !== null && portBindings !== undefined) {
      const keys = typeof portBindings === "object" ? Object.keys(portBindings as object) : [];
      if (keys.length > 0) problems.push(`published ports present: ${keys.join(",")}`);
    }
    const exposed = config["ExposedPorts"];
    if (exposed !== null && exposed !== undefined && typeof exposed === "object" && Object.keys(exposed as object).length > 0) {
      problems.push("container declares exposed ports");
    }
  }

  // Access-epoch bind: exactly ONE bind, the trusted leaf at /workspace,
  // private propagation, RW matching the trusted epoch access. This is the
  // Docker-enforced ownership boundary (design 26.1/26.3): no second bind,
  // no writable alias in a read_only epoch.
  if (mounts.length !== 1) {
    problems.push(`expected exactly one workspace bind, found ${mounts.length}`);
  } else {
    const m = asRecord(mounts[0]);
    const expectedRw = expectations.access === "read_write";
    if (m === null || m["Type"] !== "bind") {
      problems.push("workspace mount is not a bind mount");
    } else {
      if (m["Source"] !== expectations.mountSource || m["Destination"] !== SANDBOX_POLICY.mount.container_target) {
        problems.push("workspace bind is not <trusted leaf> -> /workspace");
      }
      if (m["RW"] !== expectedRw) {
        problems.push(
          expectedRw
            ? "workspace bind is not writable but the epoch is read_write"
            : "workspace bind is writable but the epoch is read_only",
        );
      }
      const propagation = typeof m["Propagation"] === "string" ? (m["Propagation"] as string) : "";
      if (propagation !== "" && propagation !== "rprivate" && propagation !== "private") {
        problems.push(`workspace bind propagation is "${propagation}" (expected private)`);
      }
    }
  }
  for (const mount of mounts) {
    const m = asRecord(mount);
    if (m === null) continue;
    const destination = typeof m["Destination"] === "string" ? (m["Destination"] as string) : "";
    const source = typeof m["Source"] === "string" ? (m["Source"] as string) : "";
    if (destination.includes("/docker.sock") || source.toLowerCase().includes("\\docker.sock")) {
      problems.push("Docker socket mount detected");
    }
  }

  // Combined-epoch scratch profile: writable tool state lives under /tmp.
  const env = Array.isArray(config["Env"]) ? (config["Env"] as string[]) : [];
  const envMap = new Map<string, string>();
  for (const entry of env) {
    const equals = entry.indexOf("=");
    if (equals === -1) continue;
    envMap.set(entry.slice(0, equals), entry.slice(equals + 1));
  }
  for (const [name, expected] of Object.entries(EPOCH_SCRATCH_ENV_EXPECTED)) {
    if (envMap.get(name) !== expected) {
      problems.push(`container env ${name} is not the fixed scratch value`);
    }
  }
  for (const entry of env) {
    const name = entry.split("=", 1)[0].toUpperCase();
    if (FORBIDDEN_ENV_FRAGMENTS.some((fragment) => name.includes(fragment))) {
      problems.push(`container env carries forbidden variable name "${name}"`);
    }
  }

  // Epoch ownership labels: the exact Course Factory owner plus the P6
  // phase marker, installation and session binding (never a global prune).
  const labels = asRecord(config["Labels"]);
  if (labels === null) {
    problems.push("container carries no ownership labels");
  } else {
    if (labels[SANDBOX_POLICY.labels.owner] !== SANDBOX_POLICY.labels.owner_value) {
      problems.push("container owner label does not match the terminal engine");
    }
    if (labels[SANDBOX_POLICY.labels.phase] !== "P6") {
      problems.push("container phase label is not P6");
    }
    if (labels[SANDBOX_POLICY.labels.installation] !== expectations.installationId) {
      problems.push("container installation label does not match the epoch owner");
    }
    if (labels[SANDBOX_POLICY.labels.session] !== expectations.sessionId) {
      problems.push("container session label does not match the epoch owner");
    }
  }

  return Object.freeze(problems);
}

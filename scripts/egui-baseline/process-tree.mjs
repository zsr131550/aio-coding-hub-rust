import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function processCollectorCapabilities(platform = process.platform) {
  if (platform === "win32") {
    return {
      collector: "windows-cim-v1",
      identity: {
        precision: "exact",
        source: "Win32_Process.CreationDate",
      },
      metrics: {
        workingSetBytes: {
          availability: "available",
          source: "Win32_Process.WorkingSetSize",
          semantics: "resident working set bytes",
        },
        privateBytes: {
          availability: "available",
          source: "Win32_Process.PrivatePageCount",
          semantics: "private committed bytes",
        },
        cpuTimeMs: {
          availability: "available",
          source: "Win32_Process.KernelModeTime+UserModeTime",
          semantics: "cumulative kernel and user CPU time",
        },
      },
    };
  }
  if (platform === "linux") {
    return {
      collector: "linux-proc-v1",
      identity: {
        precision: "exact",
        source: "/proc/<pid>/stat:starttime",
      },
      metrics: {
        workingSetBytes: {
          availability: "available",
          source: "/proc/<pid>/status:VmRSS",
          semantics: "resident set bytes reported by procfs",
        },
        privateBytes: {
          availability: "available",
          source: "/proc/<pid>/status:RssAnon",
          semantics: "resident anonymous bytes reported by procfs",
        },
        cpuTimeMs: {
          availability: "available",
          source: "/proc/<pid>/stat:utime+stime",
          semantics: "cumulative user and system CPU ticks converted with getconf CLK_TCK",
        },
      },
    };
  }
  if (platform === "darwin") {
    return {
      collector: "macos-ps-v1",
      identity: {
        precision: "coarse",
        source: "ps:lstart",
      },
      metrics: {
        workingSetBytes: {
          availability: "available",
          source: "ps:rss",
          semantics: "resident set bytes",
        },
        privateBytes: {
          availability: "unavailable",
          source: null,
          semantics: "portable macOS ps fields do not expose a reliable private-byte counter",
        },
        cpuTimeMs: {
          availability: "available",
          source: "ps:time",
          semantics: "cumulative process CPU time; unsafe for deltas with a coarse birth identity",
        },
      },
    };
  }
  return {
    collector: "unsupported",
    identity: { precision: "coarse", source: null },
    metrics: Object.fromEntries(
      ["workingSetBytes", "privateBytes", "cpuTimeMs"].map((name) => [
        name,
        { availability: "unavailable", source: null, semantics: "unsupported platform" },
      ])
    ),
  };
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredInteger(value, label) {
  const parsed = finiteNumber(value);
  if (parsed == null || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${label}`);
  }
  return parsed;
}

export function parseWindowsCimSnapshot(text) {
  const parsed = JSON.parse(text.trim() || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const kernel100ns = finiteNumber(row.KernelModeTime);
    const user100ns = finiteNumber(row.UserModeTime);
    const rawBirthToken = String(row.CreationDate ?? "");
    const serializedDate = rawBirthToken.match(/^\/Date\((\d+)\)\/$/);
    const birthToken = serializedDate ? `unix-ms:${serializedDate[1]}` : rawBirthToken;
    return {
      pid: requiredInteger(row.ProcessId, "ProcessId"),
      ppid: requiredInteger(row.ParentProcessId, "ParentProcessId"),
      birthToken,
      identityPrecision: birthToken ? "exact" : "coarse",
      imageName: String(row.Name ?? ""),
      workingSetBytes: finiteNumber(row.WorkingSetSize),
      privateBytes: finiteNumber(row.PrivatePageCount),
      cpuTimeMs:
        kernel100ns == null || user100ns == null ? null : (kernel100ns + user100ns) / 10_000,
    };
  });
}

export function parseLinuxProcStat(text) {
  const header = text.match(/^\s*(\d+)\s+\(/);
  const closeIndex = text.lastIndexOf(")");
  if (!header || closeIndex < header[0].length - 1) {
    throw new Error("invalid Linux proc stat");
  }

  const openIndex = header[0].lastIndexOf("(");
  const fields = text
    .slice(closeIndex + 1)
    .trim()
    .split(/\s+/);
  if (
    fields.length < 20 ||
    !/^\d+$/.test(fields[11]) ||
    !/^\d+$/.test(fields[12]) ||
    !/^\d+$/.test(fields[19])
  ) {
    throw new Error("invalid Linux proc stat");
  }

  return {
    pid: requiredInteger(header[1], "Linux proc stat pid"),
    ppid: requiredInteger(fields[1], "Linux proc stat ppid"),
    comm: text.slice(openIndex + 1, closeIndex),
    starttime: fields[19],
    userTimeTicks: fields[11],
    systemTimeTicks: fields[12],
  };
}

function parseProcKibField(fields, name) {
  const value = fields.get(name);
  if (value == null) return null;
  const match = /^(\d+)\s+kB$/.exec(value);
  if (!match) throw new Error(`invalid Linux proc status ${name}`);
  const kibibytes = Number(match[1]);
  const bytes = kibibytes * 1024;
  if (!Number.isSafeInteger(bytes)) throw new Error(`Linux proc status ${name} exceeds safe range`);
  return bytes;
}

export function parseLinuxProcStatus(text) {
  const fields = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return {
    workingSetBytes: parseProcKibField(fields, "VmRSS"),
    privateBytes: parseProcKibField(fields, "RssAnon"),
  };
}

function linuxCpuTimeMs(stat, clockTicksPerSecond) {
  if (!Number.isSafeInteger(clockTicksPerSecond) || clockTicksPerSecond < 1) {
    throw new Error("invalid Linux CLK_TCK");
  }
  const ticks = BigInt(stat.userTimeTicks) + BigInt(stat.systemTimeTicks);
  const milliseconds = (ticks * 1_000n) / BigInt(clockTicksPerSecond);
  const remainder = (ticks * 1_000n) % BigInt(clockTicksPerSecond);
  const value = Number(milliseconds) + Number(remainder) / clockTicksPerSecond;
  return Number.isSafeInteger(Number(milliseconds)) && Number.isFinite(value) ? value : null;
}

export async function enrichLinuxProcessSnapshot(
  rows,
  {
    clockTicksPerSecond,
    readProcStat = (pid) => readFile(`/proc/${pid}/stat`, "utf8"),
    readProcStatus = (pid) => readFile(`/proc/${pid}/status`, "utf8"),
  } = {}
) {
  if (!Number.isSafeInteger(clockTicksPerSecond) || clockTicksPerSecond < 1) {
    throw new Error("Linux process enrichment requires a positive CLK_TCK");
  }
  return Promise.all(
    rows.map(async (row) => {
      const coarse = { ...row, identityPrecision: "coarse", privateBytes: null };
      try {
        const before = parseLinuxProcStat(await readProcStat(row.pid));
        if (before.pid !== row.pid) throw new Error("Linux proc stat PID changed");
        let memory = { workingSetBytes: null, privateBytes: null };
        try {
          memory = parseLinuxProcStatus(await readProcStatus(row.pid));
        } catch {
          // The exact identity and CPU counter remain useful when procfs memory is unavailable.
        }
        const after = parseLinuxProcStat(await readProcStat(row.pid));
        if (after.pid !== row.pid || after.starttime !== before.starttime) {
          throw new Error("Linux proc stat identity changed while reading counters");
        }
        return {
          ...row,
          ppid: after.ppid,
          birthToken: after.starttime,
          identityPrecision: "exact",
          imageName: after.comm,
          workingSetBytes: memory.workingSetBytes,
          privateBytes: memory.privateBytes,
          cpuTimeMs: linuxCpuTimeMs(after, clockTicksPerSecond),
        };
      } catch {
        return coarse;
      }
    })
  );
}

function parseCpuTime(value) {
  const daySplit = value.split("-");
  const days = daySplit.length === 2 ? Number(daySplit[0]) : 0;
  const clock = daySplit.at(-1).split(":").map(Number);
  if (clock.some((part) => !Number.isFinite(part))) return null;
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (clock.length === 3) [hours, minutes, seconds] = clock;
  else if (clock.length === 2) [minutes, seconds] = clock;
  else if (clock.length === 1) [seconds] = clock;
  else return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

export function parsePosixPsSnapshot(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+?)\s*$/
    );
    if (!match) throw new Error(`invalid ps snapshot row: ${line}`);
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      birthToken: match[5],
      identityPrecision: "coarse",
      // macOS `ps comm` commonly returns an absolute executable path. Keep the
      // identity-bearing basename without persisting a machine-specific path.
      imageName: path.posix.basename(match[6]),
      workingSetBytes: Number(match[3]) * 1024,
      privateBytes: null,
      cpuTimeMs: parseCpuTime(match[4]),
    });
  }
  return rows;
}

export function processIdentityKey(process) {
  return `${process.pid}\u0000${process.birthToken}\u0000${process.identityPrecision ?? "coarse"}\u0000${process.imageName}`;
}

function comparableBirthOrder(birthToken) {
  const token = String(birthToken ?? "");
  const unixMilliseconds = token.match(/^unix-ms:(\d+)$/);
  if (unixMilliseconds) {
    return { clock: "unix-ms", value: BigInt(unixMilliseconds[1]) };
  }
  if (/^\d+$/.test(token)) {
    return { clock: "boot-ticks", value: BigInt(token) };
  }
  return null;
}

function compareBirthOrder(parent, child) {
  const parentBirth = comparableBirthOrder(parent.birthToken);
  const childBirth = comparableBirthOrder(child.birthToken);
  if (parentBirth == null || childBirth == null || parentBirth.clock !== childBirth.clock) {
    return null;
  }
  if (childBirth.value < parentBirth.value) return -1;
  if (childBirth.value > parentBirth.value) return 1;
  return 0;
}

export class ProcessTreeTracker {
  constructor(rootIdentity) {
    this.rootKey = processIdentityKey(rootIdentity);
    this.known = new Map([[this.rootKey, { ...rootIdentity }]]);
    this.terminableKeys = new Set(rootIdentity.identityPrecision === "exact" ? [this.rootKey] : []);
  }

  owns(identity) {
    const key = processIdentityKey(identity);
    const known = this.known.get(key);
    return (
      identity.identityPrecision === "exact" &&
      known?.identityPrecision === "exact" &&
      this.terminableKeys.has(key)
    );
  }

  acceptSnapshot(snapshot) {
    const currentByKey = new Map(snapshot.map((row) => [processIdentityKey(row), row]));
    const included = new Map();
    for (const key of this.known.keys()) {
      const current = currentByKey.get(key);
      if (current) included.set(key, current);
    }

    let changed = true;
    while (changed) {
      changed = false;
      const parentsByPid = new Map([...included.values()].map((row) => [row.pid, row]));
      for (const [key, row] of currentByKey) {
        const parent = parentsByPid.get(row.ppid);
        if (!included.has(key) && parent) {
          const birthOrder = compareBirthOrder(parent, row);
          if (birthOrder != null && birthOrder < 0) continue;

          included.set(key, row);
          this.known.set(key, { ...row });
          if (
            birthOrder != null &&
            parent.identityPrecision === "exact" &&
            row.identityPrecision === "exact" &&
            this.terminableKeys.has(processIdentityKey(parent))
          ) {
            this.terminableKeys.add(key);
          }
          changed = true;
        }
      }
    }

    return [...included.values()].sort((left, right) => left.pid - right.pid);
  }
}

function nullableSum(rows, key) {
  const values = rows.map((row) => row[key]);
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

export function aggregateProcessSample(processes) {
  return {
    processCount: processes.length,
    workingSetBytes: nullableSum(processes, "workingSetBytes"),
    privateBytes: nullableSum(processes, "privateBytes"),
    cpuTimeMs: nullableSum(processes, "cpuTimeMs"),
  };
}

const WINDOWS_CIM_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$rows=Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime | Select-Object ProcessId,ParentProcessId,CreationDate,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime",
  "$rows | ConvertTo-Json -Compress",
].join("; ");

let linuxClockTicksPerSecondPromise = null;

async function getLinuxClockTicksPerSecond(timeoutMs) {
  if (linuxClockTicksPerSecondPromise == null) {
    linuxClockTicksPerSecondPromise = execFileAsync("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    })
      .then(({ stdout }) => {
        const value = Number(stdout.trim());
        if (!Number.isSafeInteger(value) || value < 1) {
          throw new Error("getconf CLK_TCK returned an invalid value");
        }
        return value;
      })
      .catch((error) => {
        linuxClockTicksPerSecondPromise = null;
        throw error;
      });
  }
  return linuxClockTicksPerSecondPromise;
}

export async function collectProcessSnapshot({ timeoutMs = 5_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error("process collector timeout must be between 1 and 60000ms");
  }
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CIM_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      }
    );
    return parseWindowsCimSnapshot(stdout);
  }
  const psSnapshotPromise = execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,time=,lstart=,comm="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (process.platform === "linux") {
    const [{ stdout }, clockTicksPerSecond] = await Promise.all([
      psSnapshotPromise,
      getLinuxClockTicksPerSecond(timeoutMs),
    ]);
    return enrichLinuxProcessSnapshot(parsePosixPsSnapshot(stdout), {
      clockTicksPerSecond,
    });
  }
  const { stdout } = await psSnapshotPromise;
  const snapshot = parsePosixPsSnapshot(stdout);
  return snapshot;
}

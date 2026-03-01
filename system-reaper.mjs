/**
 * System Reaper — Periodic Cleanup of Orphan/Zombie OS Processes
 *
 * Targets:
 *   1. Orphan Claude Code shell sessions (snapshot-zsh-* with dead parent)
 *   2. Stuck proxy CLI workers (claude processes spawned by proxy, idle > threshold)
 *   3. Orphan openclaw CLI commands (status, nodes, etc. with dead parent)
 *
 * Safety rules:
 *   - Never kills gateway (managed by LaunchAgent, ppid=1 is normal)
 *   - Never kills node LaunchAgent processes
 *   - Never kills processes with a live Claude Desktop / Claude Code parent
 *   - Kills by process group to avoid leaving orphans
 *   - Only targets specific CLI subcommand patterns (not daemons)
 *
 * All public methods return new objects (immutable pattern).
 */

import { execFileSync } from "node:child_process";

// ── Configuration ─────────────────────────────────────────────────────

const DEFAULTS = Object.freeze({
  intervalMs: 300_000,          // 5 minutes between sweeps
  shellMaxAgeSec: 1800,         // 30 min — orphan shells older than this get killed
  proxyIdleThresholdSec: 600,   // 10 min — stuck proxy workers
  cliMinAgeSec: 300,            // 5 min — orphan CLI commands
  helperMinAgeSec: 1800,        // 30 min — orphan pipe helpers (python, ssh, head, tail)
});

// Known CLI subcommand patterns (transient, NOT daemons)
const CLI_PATTERNS = Object.freeze([
  "openclaw status",
  "openclaw nodes",
  "openclaw devices",
  "openclaw sessions",
  "openclaw config",
]);

// Safe parent process names — if parent matches, the shell is NOT orphaned
const SAFE_PARENT_NAMES = Object.freeze(["Claude", "node", "Electron"]);

// ── Helpers ───────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString();
}

/**
 * Parse ps elapsed time to seconds.
 * Formats: DD-HH:MM:SS, HH:MM:SS, MM:SS
 */
function parseElapsed(elapsed) {
  if (!elapsed) return 0;
  const trimmed = elapsed.trim();

  if (trimmed.includes("-")) {
    // DD-HH:MM:SS
    const [daysStr, rest] = trimmed.split("-");
    const parts = rest.split(":");
    if (parts.length < 3) return 0;
    const days = parseInt(daysStr, 10) || 0;
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseInt(parts[2], 10) || 0;
    return days * 86400 + h * 3600 + m * 60 + s;
  }

  const parts = trimmed.split(":");
  if (parts.length === 3) {
    // HH:MM:SS
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const s = parseInt(parts[2], 10) || 0;
    return h * 3600 + m * 60 + s;
  }

  if (parts.length === 2) {
    // MM:SS
    const m = parseInt(parts[0], 10) || 0;
    const s = parseInt(parts[1], 10) || 0;
    return m * 60 + s;
  }

  return 0;
}

/**
 * Run `ps` and return parsed process list.
 * Returns array of { pid, ppid, elapsed, ageSec, command }.
 */
function listProcesses() {
  try {
    const output = execFileSync("ps", ["-eo", "pid,ppid,etime,command"], {
      encoding: "utf-8",
      timeout: 10_000,
    });

    const lines = output.split("\n").slice(1); // skip header
    const procs = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Parse: PID  PPID  ELAPSED  COMMAND...
      const match = trimmed.match(/^\s*(\d+)\s+(\d+)\s+([\d:.-]+)\s+(.+)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const ppid = parseInt(match[2], 10);
      const elapsed = match[3];
      const command = match[4];
      const ageSec = parseElapsed(elapsed);

      procs.push(Object.freeze({ pid, ppid, elapsed, ageSec, command }));
    }

    return procs;
  } catch (err) {
    console.error(`[${ts()}] SYSTEM_REAPER ps error: ${err.message}`);
    return [];
  }
}

/**
 * Get the comm name for a PID.
 */
function getProcessName(pid) {
  try {
    return execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Get the process group ID for a PID.
 */
function getProcessGroup(pid) {
  try {
    return execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Kill a process, optionally by process group.
 * Returns true if kill signal was sent successfully.
 */
function killProcess(pid, useGroup = true) {
  try {
    if (useGroup) {
      const pgid = getProcessGroup(pid);
      if (pgid && pgid !== "0") {
        try {
          process.kill(-parseInt(pgid, 10), "SIGTERM");
          return true;
        } catch {
          // fallback to direct kill
        }
      }
    }
    process.kill(pid, "SIGTERM");
    return true;
  } catch (err) {
    if (err.code !== "ESRCH") {
      console.error(`[${ts()}] SYSTEM_REAPER kill error pid=${pid}: ${err.message}`);
    }
    return false;
  }
}

// ── Reaper Categories ─────────────────────────────────────────────────

/**
 * 1. Orphan Claude Code shell sessions
 *    Pattern: zsh -c ... snapshot-zsh-*
 *    Safe if: parent is Claude Desktop (Electron) or node (Claude Code)
 *    Kill if: ppid == 1 (parent died) or parent is NOT claude/node, AND age > threshold
 */
function reapOrphanShells(allProcs, config) {
  const results = [];
  const shellProcs = allProcs.filter((p) => p.command.includes("snapshot-zsh-"));

  for (const proc of shellProcs) {
    if (proc.ageSec < config.shellMaxAgeSec) continue;

    // Check parent process
    if (proc.ppid > 1) {
      const parentName = getProcessName(proc.ppid);
      const isSafe = SAFE_PARENT_NAMES.some((name) => parentName.includes(name));
      if (isSafe) continue;
    }

    // Parent is dead (ppid=1) or not a Claude process — this is an orphan
    const killed = killProcess(proc.pid, true);
    results.push(
      Object.freeze({
        category: "orphan_shell",
        pid: proc.pid,
        ppid: proc.ppid,
        ageSec: proc.ageSec,
        command: proc.command.slice(0, 120),
        killed,
      })
    );
  }

  return results;
}

/**
 * 2. Stuck proxy CLI workers
 *    Find the proxy server PID, then look for claude CLI children
 *    that have been running longer than the threshold.
 */
function reapStuckProxyWorkers(allProcs, config) {
  const results = [];

  // Find the proxy server PID
  const proxyProc = allProcs.find(
    (p) => p.command.includes("node") && p.command.includes("server.mjs")
  );
  if (!proxyProc) return results;

  // Find children of proxy that are claude CLI processes
  const proxyChildren = allProcs.filter(
    (p) =>
      p.ppid === proxyProc.pid &&
      p.command.includes("claude") &&
      !p.command.includes("server.mjs")
  );

  for (const child of proxyChildren) {
    if (child.ageSec < config.proxyIdleThresholdSec) continue;

    const killed = killProcess(child.pid, false);
    results.push(
      Object.freeze({
        category: "stuck_proxy_worker",
        pid: child.pid,
        ppid: child.ppid,
        ageSec: child.ageSec,
        command: child.command.slice(0, 120),
        killed,
      })
    );
  }

  return results;
}

/**
 * 3. Orphan openclaw CLI commands + pipe helpers
 *    Pattern: specific openclaw subcommands with ppid=1 and age > threshold
 *    NEVER targets gateway, node, proxy, or any LaunchAgent-managed process.
 */
function reapOrphanCli(allProcs, config) {
  const results = [];
  const selfPid = process.pid;

  // 3a. Known CLI subcommands
  for (const pattern of CLI_PATTERNS) {
    const matches = allProcs.filter(
      (p) =>
        p.command.includes(pattern) &&
        p.ppid === 1 &&
        p.ageSec >= config.cliMinAgeSec &&
        p.pid !== selfPid &&
        !p.command.includes("zombie-reaper") &&
        !p.command.includes("system-reaper")
    );

    for (const proc of matches) {
      const killed = killProcess(proc.pid, false);
      results.push(
        Object.freeze({
          category: "orphan_cli",
          pid: proc.pid,
          ppid: proc.ppid,
          ageSec: proc.ageSec,
          pattern,
          command: proc.command.slice(0, 120),
          killed,
        })
      );
    }
  }

  // 3b. Orphan pipe helpers: python -c json, python -m json.tool, head, tail, ssh clawdbot
  const helperProcs = allProcs.filter((p) => {
    if (p.ppid !== 1) return false;
    if (p.ageSec < config.helperMinAgeSec) return false;
    if (p.pid === selfPid) return false;

    const cmd = p.command;
    return (
      (cmd.includes("python") && cmd.includes("-c") && cmd.includes("json")) ||
      (cmd.includes("python") && cmd.includes("-m json.tool")) ||
      cmd.startsWith("head ") ||
      cmd.startsWith("tail ") ||
      (cmd.includes("ssh") && cmd.includes("clawdbot"))
    );
  });

  for (const proc of helperProcs) {
    const killed = killProcess(proc.pid, false);
    results.push(
      Object.freeze({
        category: "orphan_helper",
        pid: proc.pid,
        ppid: proc.ppid,
        ageSec: proc.ageSec,
        command: proc.command.slice(0, 120),
        killed,
      })
    );
  }

  return results;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @param {number} [options.shellMaxAgeSec]
 * @param {number} [options.proxyIdleThresholdSec]
 * @param {number} [options.cliMinAgeSec]
 * @param {number} [options.helperMinAgeSec]
 */
export function createSystemReaper(options = {}) {
  const config = Object.freeze({ ...DEFAULTS, ...options });

  let onReapCallback = null;
  let reaperInterval = null;

  // Cumulative stats (session-only, no persistence needed)
  let stats = Object.freeze({
    totalSweeps: 0,
    totalKilled: 0,
    byCategory: Object.freeze({
      orphan_shell: 0,
      stuck_proxy_worker: 0,
      orphan_cli: 0,
      orphan_helper: 0,
    }),
    lastSweepAt: null,
    lastSweepResults: [],
    recentKills: [], // ring buffer of last 50
  });

  /**
   * Run one full sweep across all categories.
   * Returns frozen results object.
   */
  function sweep() {
    const allProcs = listProcesses();
    if (allProcs.length === 0) {
      return Object.freeze({ results: [], count: 0 });
    }

    const results = [
      ...reapOrphanShells(allProcs, config),
      ...reapStuckProxyWorkers(allProcs, config),
      ...reapOrphanCli(allProcs, config),
    ];

    // Update stats immutably
    const newByCategory = { ...stats.byCategory };
    for (const r of results) {
      if (r.killed) {
        newByCategory[r.category] = (newByCategory[r.category] || 0) + 1;
      }
    }

    const killedResults = results.filter((r) => r.killed);
    const newRecent = [...stats.recentKills, ...killedResults].slice(-50);

    stats = Object.freeze({
      totalSweeps: stats.totalSweeps + 1,
      totalKilled: stats.totalKilled + killedResults.length,
      byCategory: Object.freeze(newByCategory),
      lastSweepAt: Date.now(),
      lastSweepResults: Object.freeze(results),
      recentKills: Object.freeze(newRecent),
    });

    // Log and notify
    if (results.length > 0) {
      console.log(
        `[${ts()}] SYSTEM_REAPER swept ${results.length} processes ` +
          `(${killedResults.length} killed)`
      );
      for (const r of results) {
        console.log(
          `[${ts()}] SYSTEM_REAP ${r.category} pid=${r.pid} age=${r.ageSec}s killed=${r.killed}`
        );
      }
    }

    // Fire callback for each killed process
    if (onReapCallback && killedResults.length > 0) {
      for (const r of killedResults) {
        try {
          onReapCallback(r);
        } catch {
          /* ignore callback errors */
        }
      }
    }

    return Object.freeze({ results, count: results.length });
  }

  /**
   * Set callback for reap events.
   * @param {Function} fn - (reapResult) => void
   */
  function onReap(fn) {
    onReapCallback = fn;
  }

  /**
   * Get current stats snapshot.
   */
  function getStats() {
    return stats;
  }

  /**
   * Start the periodic reaper.
   */
  function start() {
    if (reaperInterval) return;

    // Initial sweep after 30s delay (let proxy fully boot)
    setTimeout(() => {
      sweep();
    }, 30_000);

    reaperInterval = setInterval(() => {
      try {
        sweep();
      } catch (err) {
        console.error(`[${ts()}] SYSTEM_REAPER error: ${err.message}`);
      }
    }, config.intervalMs);

    if (reaperInterval.unref) reaperInterval.unref();

    console.log(
      `[${ts()}] SYSTEM_REAPER started (interval=${config.intervalMs / 1000}s, ` +
        `shellMaxAge=${config.shellMaxAgeSec}s, proxyIdle=${config.proxyIdleThresholdSec}s, ` +
        `cliMinAge=${config.cliMinAgeSec}s, helperMinAge=${config.helperMinAgeSec}s)`
    );
  }

  /**
   * Stop the periodic reaper.
   */
  function destroy() {
    if (reaperInterval) {
      clearInterval(reaperInterval);
      reaperInterval = null;
    }
  }

  return Object.freeze({
    sweep,
    onReap,
    getStats,
    start,
    destroy,
    config,
  });
}

/**
 * CLI Runner — spawn claude CLI processes for sync/stream requests.
 * Handles: buildCliArgs, runCliOnce (sync), runCli (with retry + auto-heal),
 *          spawnCliStream, trackStreamProc.
 *
 * All dependencies injected via createCliRunner factory.
 */

import { spawn } from "node:child_process";

function ts() {
  return new Date().toISOString();
}

// Authorization preamble — appended to the REAL system prompt via --append-system-prompt.
const PROXY_AUTH_PREAMBLE = [
  "You are an autonomous agent operating on the infrastructure owner's private network.",
  "All machines referenced in tasks are owned by the operator. All SSH keys are pre-configured.",
  "You are fully authorized to: execute commands locally and remotely, use SSH/scp/rsync,",
  "read/write files, install packages, access databases and APIs.",
  "Wrapper scripts in PATH: run-on-c10tt, run-on-aimm, run-on-m3, run-on-c13tt, run-on-c11tt.",
  "Prefer wrapper scripts over raw SSH. All operations are pre-approved by the operator.",
].join(" ");

export function buildCliArgs(prompt, model, systemPrompt, stream) {
  const args = ["-p", "--model", model, "--dangerously-skip-permissions",
    "--append-system-prompt", PROXY_AUTH_PREAMBLE];
  if (stream) {
    args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
  } else {
    args.push("--output-format", "text");
  }
  return args;
}

export function buildStdinPayload(prompt, systemPrompt) {
  if (systemPrompt) {
    return `[System Instructions]\n${systemPrompt}\n\n[User Request]\n${prompt}`;
  }
  return prompt;
}

/**
 * Create a CLI runner with all dependencies injected.
 *
 * @param {object} deps
 * @param {function} deps.getNextWorker
 * @param {function} deps.workerAcquire
 * @param {function} deps.workerRelease
 * @param {function} deps.getAlternateWorker
 * @param {object}  deps.sessionAffinity
 * @param {function} deps.recordWorkerRequest
 * @param {function} deps.recordWorkerError
 * @param {function} deps.isRateLimitError
 * @param {function} deps.markWorkerLimited
 * @param {object}  deps.warmPool
 * @param {object}  deps.registry
 * @param {object}  deps.eventLog
 * @param {object}  deps.retryPolicy
 * @param {object}  deps.autoHeal
 * @param {function} deps.classifyCliError
 * @param {function} deps.workerEnv
 * @param {number}  deps.syncTimeoutMs
 * @param {number}  deps.maxRetries
 * @param {object}  deps.config - CONFIG object (for autoHeal settings)
 */
export function createCliRunner({
  getNextWorker,
  workerAcquire,
  workerRelease,
  getAlternateWorker,
  sessionAffinity,
  recordWorkerRequest,
  recordWorkerError,
  isRateLimitError,
  markWorkerLimited,
  warmPool,
  registry,
  eventLog,
  retryPolicy,
  autoHeal,
  classifyCliError,
  workerEnv,
  syncTimeoutMs,
  maxRetries,
  config,
}) {
  function runCliOnce(prompt, model, systemPrompt, requestId = "", source = "", workerOverride = null, sessionKey = "") {
    return new Promise((resolve, reject) => {
      const worker = workerOverride || getNextWorker(sessionKey);
      if (sessionKey) sessionAffinity.assign(sessionKey, worker.name);
      recordWorkerRequest(worker.name);
      workerAcquire(worker.name);

      const warm = warmPool.acquire(model, false, worker);
      let proc;
      if (warm) {
        proc = warm.proc;
        console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${requestId} model=${model} WARM_HIT pid=${proc.pid}`);
      } else {
        const args = buildCliArgs(prompt, model, systemPrompt, false);
        proc = spawn(worker.bin, args, {
          env: workerEnv(worker),
          stdio: ["pipe", "pipe", "pipe"],
        });
        console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${requestId} model=${model} COLD pid=${proc.pid || "?"}`);
      }

      if (proc.stdin) {
        proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
        proc.stdin.end();
      }

      if (proc.pid) {
        registry.register({
          pid: proc.pid,
          requestId,
          model,
          mode: "sync",
          source,
          worker: `${worker.name}:${worker.bin}`,
          promptPreview: typeof prompt === "string" ? prompt.slice(0, 80) : "[structured]",
        });
      }

      const execTimer = setTimeout(() => {
        eventLog.push("timeout", { kind: "sync", pid: proc.pid, reqId: requestId, model });
        recordWorkerError(worker.name, "timeout", `sync_timeout pid=${proc.pid}`);
        console.log(`[${ts()}] SYNC_TIMEOUT pid=${proc.pid} reqId=${requestId} model=${model}`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        const err = new Error(`Execution timeout after ${syncTimeoutMs}ms`);
        err.exitCode = -1;
        err.workerName = worker.name;
        err.isTimeout = true;
        reject(err);
      }, syncTimeoutMs);

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => {
        stdout += d.toString();
        if (proc.pid) registry.touch(proc.pid);
      });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        clearTimeout(execTimer);
        workerRelease(worker.name);
        if (proc.pid) registry.unregister(proc.pid);
        const rateErr = isRateLimitError(code, stderr) || isRateLimitError(code, stdout);
        if (rateErr) {
          markWorkerLimited(worker.name, stderr || stdout);
        }
        if (code !== 0) {
          const err = new Error(`CLI exit ${code}: ${stderr}`);
          err.exitCode = code;
          err.workerName = worker.name;
          err.isRateLimit = rateErr;
          err.stderr = stderr;
          err.stdout = stdout;
          reject(err);
        } else {
          resolve(stdout.trim());
        }
      });
      proc.on("error", (err) => {
        clearTimeout(execTimer);
        workerRelease(worker.name);
        if (proc.pid) registry.unregister(proc.pid);
        err.workerName = worker.name;
        reject(err);
      });
    });
  }

  async function runCli(prompt, model, systemPrompt, requestId = "", source = "", sessionKey = "") {
    const primaryWorker = getNextWorker(sessionKey);
    const autoHealRetries = config.autoHeal?.maxRetriesPerRequest ?? 1;

    try {
      return await runCliOnce(prompt, model, systemPrompt, requestId, source, primaryWorker, sessionKey);
    } catch (err) {
      const classification = classifyCliError({
        exitCode: err.exitCode,
        stderr: err.stderr,
        stdout: err.stdout,
        err,
      });

      if (classification.healable && config.autoHeal?.enabled !== false) {
        const healResult = await autoHeal.heal(primaryWorker.name, classification.reason, requestId);
        if (healResult?.success) {
          let lastErr = null;
          for (let i = 0; i < autoHealRetries; i++) {
            try {
              return await runCliOnce(prompt, model, systemPrompt, requestId, source, primaryWorker, sessionKey);
            } catch (retryErr) {
              lastErr = retryErr;
            }
          }
          const alt = getAlternateWorker(primaryWorker.name);
          if (alt) {
            return await runCliOnce(prompt, model, systemPrompt, requestId, source, alt, sessionKey);
          }
          throw lastErr || err;
        }

        const alt = getAlternateWorker(primaryWorker.name);
        if (alt) {
          return await runCliOnce(prompt, model, systemPrompt, requestId, source, alt, sessionKey);
        }
        throw err;
      }

      return retryPolicy.withRetry(
        () => runCliOnce(prompt, model, systemPrompt, requestId, source, null, sessionKey),
        {
          maxRetries: Math.max(0, maxRetries - 1),
          onRetry: (attempt, error, delayMs) => {
            eventLog.push("retry", { reqId: requestId, attempt: attempt + 1, model, delay: delayMs, error: error.message });
            console.log(
              `[${ts()}] RETRY attempt=${attempt + 1}/${maxRetries} ` +
              `model=${model} delay=${delayMs}ms err=${error.message}`
            );
          },
        },
      );
    }
  }

  function spawnCliStream(prompt, model, systemPrompt, worker) {
    const warm = warmPool.acquire(model, true, worker);
    let proc;
    if (warm) {
      proc = warm.proc;
      console.log(`[${ts()}] STREAM_SPAWN worker=${worker.name} model=${model} WARM_HIT pid=${proc.pid}`);
    } else {
      const args = buildCliArgs(prompt, model, systemPrompt, true);
      proc = spawn(worker.bin, args, {
        env: workerEnv(worker),
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(`[${ts()}] STREAM_SPAWN worker=${worker.name} model=${model} COLD pid=${proc.pid || "?"}`);
    }
    if (proc.stdin) {
      proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
      proc.stdin.end();
    }
    proc._workerName = worker.name;
    proc._spawnedAt = Date.now();
    return proc;
  }

  function trackStreamProc(proc, requestId, model, source, worker) {
    if (proc.pid) {
      registry.register({
        pid: proc.pid,
        requestId,
        model,
        mode: "stream",
        source,
        worker: `${worker.name}:${worker.bin}`,
        promptPreview: "[stream]",
        liveInputTokens: 0,
        liveOutputTokens: 0,
      });
      proc.on("close", () => registry.unregister(proc.pid));
      proc.on("error", () => registry.unregister(proc.pid));
    }
  }

  return Object.freeze({
    runCliOnce,
    runCli,
    spawnCliStream,
    trackStreamProc,
    buildCliArgs,
    buildStdinPayload,
  });
}

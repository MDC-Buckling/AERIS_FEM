import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Container image + executable conventions — keep in sync with
// scripts/cylinder_lba.py and the deploy README.
const SOLVER_IMAGE = "aeris/gismo:v25.07.0";
const SOLVE_TIMEOUT_MS = 5 * 60 * 1000;   // 5 min hard cap per run

// Session 4.1: jobs replace the single-slot run registry. Each job owns a
// folder under output/jobs/<job-id>/ (model.json, run.json, mp.pvd, modes/).
// In-flight RUNS still indexed by runId so the existing /run-status polling
// keeps working; each entry now also carries jobId so the GUI can find
// "which job is currently running" without a separate query.
const RUNS = new Map();   // runId → { status, phase, jobId, ... }
let RUN_COUNTER = 0;

// Slug an arbitrary user-supplied job name into a path-safe folder name.
// Accepts letters / digits / dash / underscore; everything else collapses
// to a single dash. Empty input → "job-<timestamp>" so the dialog can
// "Just Submit" without forcing the user to type a name.
function slugifyJobName(name) {
  const s = String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || `job-${Date.now()}`;
}

function jobsRoot(outputRoot) {
  return path.join(outputRoot, "jobs");
}

function jobDir(outputRoot, jobId) {
  return path.join(jobsRoot(outputRoot), jobId);
}

function readJobsIndex(outputRoot) {
  const indexPath = path.join(jobsRoot(outputRoot), "index.json");
  if (!fs.existsSync(indexPath)) return { jobs: [] };
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return { jobs: [] };
  }
}

function writeJobsIndex(outputRoot, idx) {
  const root = jobsRoot(outputRoot);
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.json"),
                   JSON.stringify(idx, null, 2));
}

// Picks the latest phase marker out of the rolling stdout. Lines look like:
//   [AERIS-PHASE] solving_r5
// First word after the tag is what the GUI shows in its monitor.
function parsePhase(stdout) {
  let phase = "starting";
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[AERIS-PHASE\]\s+(\S+)/);
    if (m) { phase = m[1]; break; }
  }
  return phase;
}

// Serve ../output/ (the cylinder_lba.py output folder) under /data/ so the
// browser can fetch the multipatch .pvd / .vts files via plain fetch().
// Lets us iterate on the GUI without copying solver outputs around.
function aerisOutputServer() {
  const ROOT = path.resolve(__dirname, "..", "output");
  return {
    name: "aeris-output-server",
    configureServer(server) {
      server.middlewares.use("/data", (req, res, next) => {
        const rel = decodeURIComponent((req.url || "/").split("?")[0]);
        const safe = path.normalize(rel).replace(/^[/\\]+/, "");
        const abs = path.join(ROOT, safe);
        if (!abs.startsWith(ROOT)) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        fs.stat(abs, (err, st) => {
          if (err || !st.isFile()) return next();
          const ext = path.extname(abs).toLowerCase();
          const type = ext === ".pvd" || ext === ".vts" || ext === ".vtp"
            ? "application/xml"
            : "application/octet-stream";
          res.setHeader("Content-Type", type);
          res.setHeader("Cache-Control", "no-store");
          fs.createReadStream(abs).pipe(res);
        });
      });

      // POST /save-model[?jobId=<id>] — write the GUI's serialised model
      // into the job's folder (output/jobs/<id>/model.json) when jobId is
      // given, else the legacy flat output/model.json path. Lets the GUI
      // pre-save a model under a job ID before /run-solver picks it up.
      server.middlewares.use("/save-model", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        const url = new URL(req.url, "http://x");
        const jobId = url.searchParams.get("jobId");
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const obj = JSON.parse(text);   // validate JSON
            const targetDir = jobId
              ? jobDir(ROOT, slugifyJobName(jobId))
              : ROOT;
            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const out = path.join(targetDir, "model.json");
            fs.writeFileSync(out, JSON.stringify(obj, null, 2));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: out, bytes: text.length, jobId }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });

      // GET    /jobs           — return on-disk job index
      // POST   /jobs           — create a new job
      // DELETE /jobs/<id>      — remove the folder + index entry
      // GET    /jobs/<id>      — get a single job's record + run.json
      server.middlewares.use("/jobs", (req, res, next) => {
        const rest = (req.url || "/").split("?")[0].replace(/^\/+/, "");

        // ------- per-job sub-paths -----------------------------------------
        if (rest.length > 0) {
          const id = slugifyJobName(decodeURIComponent(rest.split("/")[0]));
          const dir = jobDir(ROOT, id);

          if (req.method === "DELETE") {
            const idx = readJobsIndex(ROOT);
            const existed = idx.jobs.find((j) => j.id === id);
            if (!existed) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: `no job '${id}'` }));
              return;
            }
            // Refuse to delete if its run is currently in flight — the
            // user would lose the in-progress stdout buffer. Surface the
            // running runId so the GUI can offer a "cancel first" path
            // later (Phase 3).
            const live = [...RUNS.values()].find(
              (r) => r.jobId === id && r.status === "running"
            );
            if (live) {
              res.statusCode = 409;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({
                ok: false,
                error: `job '${id}' is currently running — cancel it first`,
                runId: live.runId,
              }));
              return;
            }
            try { fs.rmSync(dir, { recursive: true, force: true }); }
            catch (e) { /* missing folder is fine */ }
            idx.jobs = idx.jobs.filter((j) => j.id !== id);
            writeJobsIndex(ROOT, idx);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, id }));
            return;
          }

          if (req.method === "GET") {
            const idx = readJobsIndex(ROOT);
            const job = idx.jobs.find((j) => j.id === id);
            if (!job) {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: `no job '${id}'` }));
              return;
            }
            let manifest = null;
            const runPath = path.join(dir, "run.json");
            if (fs.existsSync(runPath)) {
              try { manifest = JSON.parse(fs.readFileSync(runPath, "utf8")); }
              catch (e) { /* leave null on parse error */ }
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, job, manifest }));
            return;
          }

          res.statusCode = 405;
          res.end("GET or DELETE");
          return;
        }

        // ------- collection -----------------------------------------------
        if (req.method === "GET") {
          const idx = readJobsIndex(ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, ...idx }));
          return;
        }
        if (req.method === "POST") {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => {
            let body = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
            catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: false, error: "bad JSON body" }));
              return;
            }
            const id = slugifyJobName(body.name);
            const dir = jobDir(ROOT, id);
            const idx = readJobsIndex(ROOT);
            const existing = idx.jobs.find((j) => j.id === id);
            if (existing && !body.overwrite) {
              res.statusCode = 409;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({
                ok: false, error: `job '${id}' already exists`,
                hint: "POST { name, overwrite: true } to replace, or pick a different name",
              }));
              return;
            }
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (body.model) {
              fs.writeFileSync(path.join(dir, "model.json"),
                               JSON.stringify(body.model, null, 2));
            }
            const record = {
              id,
              name: body.name || id,
              createdAt: new Date().toISOString(),
              threads: Math.max(1, Math.min(64, Number(body.threads) || 1)),
              lastRunStatus: "idle",     // updated when /run-solver completes
              lastRunAt: null,
            };
            // Prepend so newest is first in the GUI list.
            idx.jobs = [record, ...idx.jobs.filter((j) => j.id !== id)];
            writeJobsIndex(ROOT, idx);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, job: record }));
          });
          return;
        }
        res.statusCode = 405;
        res.end("GET or POST");
      });

      // POST /run-solver — async start. Spawns the docker container, returns
      // immediately with a runId. Client polls /run-status?id=<id> for
      // progress + final result. Phase markers ([AERIS-PHASE] <name>) emitted
      // by cylinder_lba.py drive the live monitor; the rolling stdout is
      // kept in memory until the next run replaces it.
      server.middlewares.use("/run-solver", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          let opts = {};
          try {
            opts = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: "bad JSON body" }));
            return;
          }

          const scriptsDir = path.resolve(__dirname, "..", "scripts");
          const outputDir  = path.resolve(__dirname, "..", "output");
          const jobId = opts.jobId ? slugifyJobName(opts.jobId) : null;
          // Per-job folder if jobId given (the GUI flow always sets it now),
          // else legacy flat output/ for back-compat with older /save-model
          // callers. Either way the host-mounted dir becomes /work in
          // the container.
          const workDir = jobId ? jobDir(outputDir, jobId) : outputDir;
          const modelPath = path.join(workDir, "model.json");
          if (!fs.existsSync(modelPath)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              ok: false,
              error: `model.json not found at ${modelPath}; call /save-model first`,
            }));
            return;
          }

          // Threads: 1 by default (single-thread, deterministic). G+Smo
          // wrapped in OpenMP picks up OMP_NUM_THREADS, so this is the
          // simplest way to surface parallelisation to the user.
          const threads = Math.max(1, Math.min(64, Number(opts.threads) || 1));
          const refinement = Number.isFinite(opts.refinement) ? opts.refinement : 5;
          const args = [
            "run", "--rm",
            "-e", `OMP_NUM_THREADS=${threads}`,
            "-v", `${scriptsDir}:/scripts:ro`,
            "-v", `${workDir}:/work:rw`,
            SOLVER_IMAGE,
            "python3", "-u",                  // -u: unbuffered, so phase
                                              // markers flush in real time
            "/scripts/cylinder_lba.py",
            "--model", "/work/model.json",
            "--refines", String(refinement),
            "--plot-dir", "/work",
          ];

          const runId = `run-${Date.now()}-${++RUN_COUNTER}`;
          const started = Date.now();
          const child = spawn("docker", args, { windowsHide: true });
          const record = {
            runId,
            jobId,
            threads,
            status: "running",
            phase: "starting",
            started,
            stdout: "",
            stderr: "",
            exitCode: null,
            signal: null,
            killedByTimeout: false,
            durationMs: 0,
            command: ["docker", ...args].join(" "),
            child,
          };
          RUNS.set(runId, record);

          child.stdout.on("data", (c) => {
            record.stdout += c.toString("utf8");
            record.phase = parsePhase(record.stdout);
          });
          child.stderr.on("data", (c) => {
            record.stderr += c.toString("utf8");
          });

          const timer = setTimeout(() => {
            record.killedByTimeout = true;
            try { child.kill("SIGKILL"); } catch {}
          }, SOLVE_TIMEOUT_MS);

          child.on("error", (err) => {
            clearTimeout(timer);
            record.status = "failed";
            record.error = `failed to spawn docker: ${err.message} — is Docker Desktop running and is the aeris/gismo image built?`;
            record.durationMs = Date.now() - started;
            record.child = null;
          });
          child.on("close", (code, signal) => {
            clearTimeout(timer);
            record.exitCode = code;
            record.signal = signal;
            record.durationMs = Date.now() - started;
            record.status = code === 0 ? "success" : "failed";
            if (record.status === "success") record.phase = "done";
            record.child = null;
            // Persist last-run status onto the job index so the GUI's
            // jobs list reflects "success / failed" without polling
            // /run-status for every past job.
            if (jobId) {
              try {
                const idx = readJobsIndex(outputDir);
                const j = idx.jobs.find((e) => e.id === jobId);
                if (j) {
                  j.lastRunStatus = record.status;
                  j.lastRunAt = new Date().toISOString();
                  j.lastDurationMs = record.durationMs;
                  writeJobsIndex(outputDir, idx);
                }
              } catch { /* index race — non-fatal */ }
            }
          });

          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, runId }));
        });
      });

      // GET /run-status?id=<runId>&tail=<bytes> — poll endpoint for the
      // live solver monitor. Returns the run record sans the live child
      // handle, with stdout truncated to the last `tail` bytes (default
      // 4096) to keep the polling response light.
      server.middlewares.use("/run-status", (req, res) => {
        const url = new URL(req.url, "http://x");
        const runId = url.searchParams.get("id");
        const tail = Math.max(0, Math.min(64 * 1024, Number(url.searchParams.get("tail") || 4096)));
        const r = RUNS.get(runId);
        res.setHeader("Content-Type", "application/json");
        if (!r) {
          res.statusCode = 404;
          res.end(JSON.stringify({ ok: false, error: `unknown runId ${runId}` }));
          return;
        }
        const elapsed = r.status === "running"
          ? Date.now() - r.started
          : r.durationMs;
        const tailStdout = r.stdout.length > tail
          ? r.stdout.slice(-tail)
          : r.stdout;
        res.end(JSON.stringify({
          ok: true,
          runId: r.runId,
          status: r.status,
          phase: r.phase,
          elapsedMs: elapsed,
          durationMs: r.durationMs,
          exitCode: r.exitCode,
          signal: r.signal,
          killedByTimeout: r.killedByTimeout,
          stdoutLength: r.stdout.length,
          stdoutTail: tailStdout,
          stderr: r.stderr,
          error: r.error,
          command: r.command,
          // Full stdout only on terminal status, so the client can grab
          // it once for archival / sidecar parsing in Session 4.0.
          stdout: (r.status === "success" || r.status === "failed") ? r.stdout : undefined,
        }));
      });

      // /data-index : tiny JSON manifest of what's actually on disk, so the
      // ResultsPanel can populate itself without hard-coding filenames.
      server.middlewares.use("/data-index", (req, res) => {
        const inventory = (() => {
          try {
            const top = fs.readdirSync(ROOT, { withFileTypes: true });
            const files = top.filter((e) => e.isFile()).map((e) => e.name);
            const modesDir = path.join(ROOT, "modes");
            let modes = [];
            if (fs.existsSync(modesDir)) {
              modes = fs.readdirSync(modesDir).filter((n) => n.endsWith(".pvd"));
            }
            return { ok: true, root: files, modes };
          } catch (e) {
            return { ok: false, error: String(e) };
          }
        })();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(inventory));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), aerisOutputServer()],
  server: {
    port: 5174,
    strictPort: false,
    fs: { allow: [".."] },
  },
  build: { target: "esnext" },
  clearScreen: false,
});

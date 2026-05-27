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

// Single-slot run registry. The dev server is local and one user → at most
// one in-flight solve at a time, so we don't need a real job queue yet. The
// next live run replaces this slot (the previous run's stdout stays available
// until then via the same /run-status response). A multi-user / cloud version
// will swap this for a keyed map + auth.
const RUNS = new Map();   // runId → { status, phase, child, started, stdout, stderr, ... }
let RUN_COUNTER = 0;

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

      // POST /save-model — write the GUI's serialised model into
      // ../output/model.json so the Python side (cylinder_lba.py --model
      // .../output/model.json) can consume it. Used by the GUI's Export
      // Model button. Pure dev-server convenience — when the Solve button
      // lands in a later session it'll go through the same endpoint.
      server.middlewares.use("/save-model", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end("POST only");
          return;
        }
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const obj = JSON.parse(text);   // round-trip to validate JSON
            if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
            const out = path.join(ROOT, "model.json");
            fs.writeFileSync(out, JSON.stringify(obj, null, 2));
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, path: out, bytes: text.length }));
          } catch (e) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
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
          const modelPath  = path.join(outputDir, "model.json");
          if (!fs.existsSync(modelPath)) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({
              ok: false,
              error: `model.json not found at ${modelPath}; call /save-model first`,
            }));
            return;
          }

          const refinement = Number.isFinite(opts.refinement) ? opts.refinement : 5;
          const args = [
            "run", "--rm",
            "-v", `${scriptsDir}:/scripts:ro`,
            "-v", `${outputDir}:/work:rw`,
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

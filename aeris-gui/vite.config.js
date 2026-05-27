import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

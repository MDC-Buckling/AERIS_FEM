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

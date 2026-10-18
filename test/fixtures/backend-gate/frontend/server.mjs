// Gate 3a's stand-in for `vite`: no dependencies, so `npm install` needs no
// registry and the gate measures the harness, not a package download.
//
//   node server.mjs [port]        # `npm run dev` passes none: 5173, the run contract's
//
// It serves index.html on 127.0.0.1 and [::1] (loopback only, as Vite's
// default `localhost` does), forwards `/api/*` to 127.0.0.1:5100 the way an
// attempt's dev-server proxy does, and prints Vite's banner once both
// listeners are up — the `Local:` line is what scripts/lib/dev-server.ts
// reads the port from. SIGTERM ends it, as it ends Vite.
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";

const port = Number(process.argv[2] ?? 5173);
const page = readFileSync(new URL("./index.html", import.meta.url));

function handle(req, res) {
  if (req.url.startsWith("/api/")) {
    const upstream = request({ host: "127.0.0.1", port: 5100, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    upstream.on("error", (error) => {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`proxy error: ${error.message}\n`);
    });
    req.pipe(upstream);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
}

const v4 = createServer(handle);
v4.listen(port, "127.0.0.1", () => {
  const bound = v4.address().port;
  const banner = () => console.log(`\n  VITE v5.0.0  ready in 10 ms\n\n  ➜  Local:   http://localhost:${bound}/\n`);
  const v6 = createServer(handle);
  // Where there is no IPv6 loopback, 127.0.0.1 alone is enough.
  v6.once("error", banner);
  v6.listen(bound, "::1", banner);
});

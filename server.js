const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const SUPABASE_BUNDLE_PATH = path.resolve(
  __dirname,
  "node_modules",
  "@supabase",
  "supabase-js",
  "dist",
  "umd",
  "supabase.js"
);
const SUPABASE_ORIGIN = (() => {
  try {
    const u = new URL(process.env.SUPABASE_URL || "https://yvqndfyiwkegxkeolvoh.supabase.co");
    if (u.protocol !== "https:") throw new Error("Only https Supabase origin is allowed");
    return u;
  } catch (e) {
    return new URL("https://yvqndfyiwkegxkeolvoh.supabase.co");
  }
})();

const ALLOWED_SB_PREFIXES = ["/rest/v1/", "/storage/v1/", "/realtime/v1/"];
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB for JSON API routes

const apiHandlers = {
  "/api/config": require("./api/config.js"),
  "/api/admin-login": require("./api/admin-login.js"),
  "/api/translate": require("./api/translate.js"),
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const COMPRESSIBLE_EXTS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg"]);
const staticCache = new Map();

function loadStaticEntry(filePath, stats, ext, cb) {
  const cached = staticCache.get(filePath);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
    cb(null, cached);
    return;
  }
  fs.readFile(filePath, (err, raw) => {
    if (err) {
      cb(err);
      return;
    }
    const entry = {
      mtimeMs: stats.mtimeMs,
      size: stats.size,
      mime: MIME_TYPES[ext] || "application/octet-stream",
      etag: `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
      compressible: COMPRESSIBLE_EXTS.has(ext) && raw.length >= 1024,
      raw,
      gzip: null,
      br: null,
    };
    if (entry.compressible) {
      try {
        entry.gzip = zlib.gzipSync(raw, { level: 6 });
      } catch (e) {}
      try {
        if (typeof zlib.brotliCompressSync === "function") {
          entry.br = zlib.brotliCompressSync(raw, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
          });
        }
      } catch (e) {}
    }
    if (staticCache.size > 64) staticCache.clear();
    staticCache.set(filePath, entry);
    cb(null, entry);
  });
}

function serveStaticEntry(req, res, entry, cacheControl) {
  res.setHeader("Content-Type", entry.mime);
  res.setHeader("ETag", entry.etag);
  res.setHeader("Cache-Control", cacheControl || "no-cache");
  if (entry.compressible) res.setHeader("Vary", "Accept-Encoding");

  if (req.headers["if-none-match"] === entry.etag) {
    res.statusCode = 304;
    res.end();
    return;
  }

  let body = entry.raw;
  if (entry.compressible) {
    const ae = String(req.headers["accept-encoding"] || "");
    if (entry.br && /\bbr\b/i.test(ae)) {
      res.setHeader("Content-Encoding", "br");
      body = entry.br;
    } else if (entry.gzip && /\bgzip\b/i.test(ae)) {
      res.setHeader("Content-Encoding", "gzip");
      body = entry.gzip;
    }
  }
  res.setHeader("Content-Length", body.length);
  res.statusCode = 200;
  res.end(req.method === "HEAD" ? undefined : body);
}

function enhanceResponse(res) {
  res.status = function (code) {
    res.statusCode = code;
    return res;
  };
  res.json = function (data) {
    if (!res.getHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(data));
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      resolve(undefined);
      return;
    }
    const chunks = [];
    let total = 0;
    let exceeded = false;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (exceeded) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        resolve(raw);
      }
    });
    req.on("error", () => resolve({}));
  });
}

function isAllowedSupabasePath(sbPath) {
  if (!sbPath || sbPath.includes("..") || sbPath.includes("\\")) return false;
  return ALLOWED_SB_PREFIXES.some((prefix) => sbPath.startsWith(prefix));
}

function proxySupabaseHttp(req, res, parsedUrl) {
  const sbPath = parsedUrl.pathname.slice(3) + (parsedUrl.search || "");
  if (!isAllowedSupabasePath(parsedUrl.pathname.slice(3))) {
    res.status(403).json({ error: "Forbidden proxy path" });
    return;
  }

  const headers = {};
  const skipHeaders = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "origin",
    "referer",
    "cookie",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]);
  for (const [k, v] of Object.entries(req.headers)) {
    if (!skipHeaders.has(k.toLowerCase()) && v !== undefined) {
      headers[k] = v;
    }
  }
  headers.host = SUPABASE_ORIGIN.host;

  const proxyReq = https.request(
    {
      hostname: SUPABASE_ORIGIN.hostname,
      port: SUPABASE_ORIGIN.port || 443,
      path: sbPath,
      method: req.method,
      headers,
      timeout: 25000,
    },
    (proxyRes) => {
      const resHeaders = {};
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        const lk = k.toLowerCase();
        if (lk === "set-cookie" || lk === "connection" || lk === "keep-alive" || lk === "transfer-encoding") {
          continue;
        }
        if (v !== undefined) resHeaders[k] = v;
      }
      res.writeHead(proxyRes.statusCode || 502, resHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("timeout", () => {
    proxyReq.destroy(new Error("Upstream timeout"));
  });

  proxyReq.on("error", (err) => {
    console.error("Supabase HTTP proxy error:", err && err.message ? err.message : err);
    if (!res.headersSent) {
      res.status(502).json({ error: "Upstream unavailable" });
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.pipe(proxyReq);
}

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);
  let parsedUrl;
  let pathname;
  try {
    parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    pathname = decodeURIComponent(parsedUrl.pathname);
  } catch (e) {
    res.status(400).end("Bad Request");
    return;
  }

  if (pathname.startsWith("/sb/")) {
    proxySupabaseHttp(req, res, parsedUrl);
    return;
  }

  if (pathname === "/vendor/supabase.js") {
    fs.stat(SUPABASE_BUNDLE_PATH, (err, stats) => {
      if (err || !stats.isFile()) {
        res.status(404).end("Not found");
        return;
      }
      loadStaticEntry(SUPABASE_BUNDLE_PATH, stats, ".js", (loadErr, entry) => {
        if (loadErr || !entry) {
          if (!res.headersSent) res.status(500).end("Read error");
          return;
        }
        serveStaticEntry(req, res, entry, "public, max-age=86400");
      });
    });
    return;
  }

  if (apiHandlers[pathname]) {
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.body = await readBody(req);
    req._hasSbProxy = true;
    try {
      await apiHandlers[pathname](req, res);
    } catch (err) {
      console.error("API error:", err);
      if (!res.writableEnded) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.status(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      const indexFile = path.join(PUBLIC_DIR, "index.html");
      fs.stat(indexFile, (idxStatErr, idxStats) => {
        if (idxStatErr || !idxStats.isFile()) {
          res.status(404).end("Not found");
          return;
        }
        loadStaticEntry(indexFile, idxStats, ".html", (loadErr, entry) => {
          if (loadErr || !entry) {
            res.status(404).end("Not found");
            return;
          }
          serveStaticEntry(req, res, entry);
        });
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (stats.size <= 2 * 1024 * 1024) {
      loadStaticEntry(filePath, stats, ext, (loadErr, entry) => {
        if (loadErr || !entry) {
          if (!res.headersSent) res.status(500).end("Read error");
          return;
        }
        serveStaticEntry(req, res, entry);
      });
      return;
    }

    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.setHeader("Content-Type", mime);
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) res.status(500).end("Read error");
    });
    stream.pipe(res);
  });
});

server.on("upgrade", (req, clientSocket, head) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  } catch (e) {
    clientSocket.destroy();
    return;
  }

  if (!parsedUrl.pathname.startsWith("/sb/realtime/v1/")) {
    clientSocket.destroy();
    return;
  }

  const upstreamPath = parsedUrl.pathname.slice(3) + (parsedUrl.search || "");
  if (!isAllowedSupabasePath(parsedUrl.pathname.slice(3))) {
    clientSocket.destroy();
    return;
  }

  const upstream = tls.connect(
    {
      host: SUPABASE_ORIGIN.hostname,
      port: Number(SUPABASE_ORIGIN.port) || 443,
      servername: SUPABASE_ORIGIN.hostname,
    },
    () => {
      const lines = [`GET ${upstreamPath} HTTP/1.1`];
      lines.push(`Host: ${SUPABASE_ORIGIN.host}`);
      lines.push(`Origin: ${SUPABASE_ORIGIN.origin}`);
      const passHeaders = [
        "upgrade",
        "connection",
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
        "user-agent",
      ];
      for (const h of passHeaders) {
        if (req.headers[h]) {
          lines.push(`${h}: ${req.headers[h]}`);
        }
      }
      lines.push("\r\n");
      upstream.write(lines.join("\r\n"));
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }
  );

  upstream.on("error", (err) => {
    console.error("Supabase WS proxy error:", err && err.message ? err.message : err);
    try { clientSocket.destroy(); } catch (e) {}
  });
  clientSocket.on("error", () => {
    try { upstream.destroy(); } catch (e) {}
  });
  clientSocket.on("close", () => {
    try { upstream.destroy(); } catch (e) {}
  });
  upstream.on("close", () => {
    try { clientSocket.destroy(); } catch (e) {}
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat Room server running at http://0.0.0.0:${PORT}`);
});

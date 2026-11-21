const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

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

function serveStaticEntry(req, res, entry) {
  res.setHeader("Content-Type", entry.mime);
  res.setHeader("ETag", entry.etag);
  res.setHeader("Cache-Control", "no-cache");
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
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
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

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);
  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  if (apiHandlers[pathname]) {
    req.query = Object.fromEntries(parsedUrl.searchParams.entries());
    req.body = await readBody(req);
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

  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Chat Room server running at http://0.0.0.0:${PORT}`);
});

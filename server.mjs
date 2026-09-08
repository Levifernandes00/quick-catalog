import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  deletePhoto,
  downloadPhoto,
  loadCatalog,
  saveCatalog,
  uploadPhoto,
} from "./lib/google-drive.mjs";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "public");
const PORT = Number(process.env.PORT) || 3847;
const MAX_BODY = 8 * 1024 * 1024;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers,
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Arquivo grande demais (máx. 8 MB)."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sanitizeProducts(products) {
  if (!Array.isArray(products)) return [];
  return products
    .map((p) => {
      if (!p || typeof p !== "object") return null;
      const id = String(p.id || "").trim();
      const name = String(p.name || "").trim();
      if (!id || !name) return null;
      const quantity = Math.max(0, Number.parseInt(p.quantity, 10) || 0);
      const perBox = Math.max(1, Number.parseInt(p.perBox, 10) || 1);
      const expiresAt = String(p.expiresAt || "").slice(0, 10);
      return {
        id,
        name,
        quantity,
        perBox,
        expiresAt,
        hasPhoto: Boolean(p.hasPhoto),
        createdAt: p.createdAt || new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

function publicFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const full = path.normalize(path.join(publicDir, rel));
  if (!full.startsWith(publicDir + path.sep) && full !== publicDir) return null;
  return full;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/products") {
    const catalog = await loadCatalog();
    sendJson(res, 200, catalog);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/products") {
    const raw = await readBody(req);
    let data;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "JSON inválido." });
      return;
    }
    const catalog = {
      updatedAt: new Date().toISOString(),
      products: sanitizeProducts(data.products),
    };
    await saveCatalog(catalog);
    sendJson(res, 200, catalog);
    return;
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/([^/]+)$/);
  if (photoMatch && req.method === "GET") {
    const id = decodeURIComponent(photoMatch[1]);
    const file = await downloadPhoto(id);
    if (!file) {
      sendJson(res, 404, { error: "Foto não encontrada." });
      return;
    }
    send(res, 200, file.buffer, {
      "Content-Type": file.mimeType || "image/jpeg",
      "Cache-Control": "private, max-age=60",
    });
    return;
  }

  const uploadMatch = url.pathname.match(/^\/api\/products\/([^/]+)\/photo$/);
  if (uploadMatch && req.method === "POST") {
    const id = decodeURIComponent(uploadMatch[1]);
    const buffer = await readBody(req);
    if (!buffer.length) {
      sendJson(res, 400, { error: "Foto vazia." });
      return;
    }
    const mimeType = (req.headers["content-type"] || "image/jpeg").split(";")[0];
    await uploadPhoto(id, buffer, mimeType.startsWith("image/") ? mimeType : "image/jpeg");
    sendJson(res, 200, { ok: true, id });
    return;
  }

  if (uploadMatch && req.method === "DELETE") {
    const id = decodeURIComponent(uploadMatch[1]);
    await deletePhoto(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota não encontrada." });
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Método não permitido." });
    return;
  }
  const filePath = publicFilePath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Não encontrado", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  const ext = path.extname(filePath);
  const body = fs.readFileSync(filePath);
  send(res, 200, body, { "Content-Type": MIME[ext] || "application/octet-stream" });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    console.error(e);
    sendJson(res, status, { error: e.message || "Erro interno." });
  }
});

function lanAddresses() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Catálogo em http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`No celular:  http://${ip}:${PORT}`);
  }
});

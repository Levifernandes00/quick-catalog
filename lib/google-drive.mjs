// Google Drive — mesma autenticação do Fundo Bíblico (service account).
// A chave fica só no servidor. A pasta precisa estar compartilhada com a SA como Editor.
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { google } from "googleapis";

dns.setDefaultResultOrder("ipv4first");

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const driveOpts = { supportsAllDrives: true };
const listOpts = { supportsAllDrives: true, includeItemsFromAllDrives: true };

const CATALOG_FILE = "catalogo.json";
const APP_FOLDER = "Catalogo";
const PHOTOS_FOLDER = "fotos";

function getServiceAccountEmail() {
  try {
    const creds = getCredentials();
    if (typeof creds.client_email === "string") return creds.client_email;
  } catch {
    /* ignore */
  }
  return "fondo-biblico-drive@projetoscci.iam.gserviceaccount.com";
}

function folderAccessHelp() {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID ?? "";
  const email = getServiceAccountEmail();
  return (
    `Pasta do Drive inacessível (ID: ${folderId}). ` +
    `Compartilhe a pasta com ${email} como Editor. ` +
    `Service accounts não têm espaço próprio no Drive.`
  );
}

function wrapDriveError(e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|fetch failed/i.test(msg)) {
    return new Error("Sem conexão com o Google Drive. Verifique a internet e tente de novo.");
  }
  if (/storage quota|do not have storage quota/i.test(msg)) {
    return new Error(
      "O Google não deixa a service account gravar ficheiros numa pasta pessoal do Drive. " +
        "Use uma pasta num Drive compartilhado (como a do Fundo Bíblico) e partilhe-a com " +
        `${getServiceAccountEmail()} como Editor.`,
    );
  }
  if (/File not found|not found/i.test(msg)) {
    return new Error(folderAccessHelp());
  }
  return e instanceof Error ? e : new Error(msg);
}

function readCredentialsFile(filePath) {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Arquivo de credenciais não encontrado: ${resolved}`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS aponta para um JSON inválido: ${resolved}`);
  }
}

function getCredentials() {
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile?.trim()) return readCredentialsFile(keyFile.trim());

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (json) {
    try {
      return JSON.parse(json);
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON inválido.");
    }
  }

  throw new Error("Credenciais Google em falta. Copie o .env do Fundo Bíblico (veja o README).");
}

let _drive = null;

function getDrive() {
  if (_drive) return _drive;
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const auth = keyFile
    ? new google.auth.GoogleAuth({
        keyFile: path.isAbsolute(keyFile) ? keyFile : path.resolve(process.cwd(), keyFile),
        scopes: [DRIVE_SCOPE],
      })
    : new google.auth.GoogleAuth({
        credentials: getCredentials(),
        scopes: [DRIVE_SCOPE],
      });
  _drive = google.drive({ version: "v3", auth });
  return _drive;
}

function rootFolderId() {
  const id = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  if (!id) {
    throw new Error("Falta GOOGLE_DRIVE_FOLDER_ID. Veja o README.");
  }
  return id;
}

const folderCache = new Map();

async function findFile(parentId, name) {
  const drive = getDrive();
  const escaped = name.replace(/'/g, "\\'");
  const q = `name='${escaped}' and '${parentId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id, mimeType)",
    pageSize: 1,
    ...listOpts,
  });
  return list.data.files?.[0] ?? null;
}

async function findOrCreateFolder(parentId, name) {
  const cacheKey = `${parentId}/${name}`;
  const cached = folderCache.get(cacheKey);
  if (cached) return cached;

  try {
    const existing = await findFile(parentId, name);
    if (existing?.id) {
      folderCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const drive = getDrive();
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      },
      fields: "id",
      ...driveOpts,
    });
    const id = created.data.id;
    if (!id) throw new Error(`Não foi possível criar a pasta: ${name}`);
    folderCache.set(cacheKey, id);
    return id;
  } catch (e) {
    throw wrapDriveError(e);
  }
}

async function catalogFolderId() {
  return findOrCreateFolder(rootFolderId(), APP_FOLDER);
}

async function photosFolderId() {
  const catalogId = await catalogFolderId();
  return findOrCreateFolder(catalogId, PHOTOS_FOLDER);
}

function photoFileName(productId) {
  return `${productId}.jpg`;
}

export async function loadCatalog() {
  try {
    const drive = getDrive();
    const existing = await findFile(await catalogFolderId(), CATALOG_FILE);
    if (!existing?.id) {
      return { updatedAt: null, products: [] };
    }

    const res = await drive.files.get(
      { fileId: existing.id, alt: "media", ...driveOpts },
      { responseType: "arraybuffer" },
    );
    const text = Buffer.from(res.data).toString("utf8");
    const data = JSON.parse(text);
    return {
      updatedAt: data.updatedAt ?? null,
      products: Array.isArray(data.products) ? data.products : [],
    };
  } catch (e) {
    throw wrapDriveError(e);
  }
}

export async function saveCatalog(catalog) {
  try {
    const drive = getDrive();
    const payload = JSON.stringify(
      {
        updatedAt: catalog.updatedAt ?? new Date().toISOString(),
        products: catalog.products ?? [],
      },
      null,
      2,
    );
    const parentId = await catalogFolderId();
    const existing = await findFile(parentId, CATALOG_FILE);
    const body = Readable.from(Buffer.from(payload, "utf8"));

    if (existing?.id) {
      await drive.files.update({
        fileId: existing.id,
        media: { mimeType: "application/json", body },
        ...driveOpts,
      });
      return existing.id;
    }

    const created = await drive.files.create({
      requestBody: {
        name: CATALOG_FILE,
        parents: [parentId],
        mimeType: "application/json",
      },
      media: { mimeType: "application/json", body },
      fields: "id",
      ...driveOpts,
    });
    return created.data.id;
  } catch (e) {
    throw wrapDriveError(e);
  }
}

export async function uploadPhoto(productId, buffer, mimeType = "image/jpeg") {
  try {
    const drive = getDrive();
    const parentId = await photosFolderId();
    const name = photoFileName(productId);
    const existing = await findFile(parentId, name);
    const body = Readable.from(buffer);
    const media = { mimeType, body };

    if (existing?.id) {
      await drive.files.update({
        fileId: existing.id,
        media,
        ...driveOpts,
      });
      return existing.id;
    }

    const created = await drive.files.create({
      requestBody: { name, parents: [parentId] },
      media,
      fields: "id",
      ...driveOpts,
    });
    if (!created.data.id) throw new Error("Upload da foto falhou.");
    return created.data.id;
  } catch (e) {
    throw wrapDriveError(e);
  }
}

export async function downloadPhoto(productId) {
  try {
    const drive = getDrive();
    const parentId = await photosFolderId();
    const existing = await findFile(parentId, photoFileName(productId));
    if (!existing?.id) return null;

    const res = await drive.files.get(
      { fileId: existing.id, alt: "media", ...driveOpts },
      { responseType: "arraybuffer" },
    );
    return {
      buffer: Buffer.from(res.data),
      mimeType: existing.mimeType || "image/jpeg",
    };
  } catch (e) {
    throw wrapDriveError(e);
  }
}

export async function deletePhoto(productId) {
  try {
    const drive = getDrive();
    const parentId = await photosFolderId();
    const existing = await findFile(parentId, photoFileName(productId));
    if (!existing?.id) return;
    try {
      await drive.files.delete({ fileId: existing.id, ...driveOpts });
    } catch {
      await drive.files.update({
        fileId: existing.id,
        requestBody: { trashed: true },
        ...driveOpts,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return;
    throw wrapDriveError(e);
  }
}

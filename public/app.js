const DB_NAME = "catalogo";
const DB_VERSION = 1;
const SOON_DAYS = 7;

const els = {
  list: document.getElementById("productList"),
  empty: document.getElementById("emptyState"),
  search: document.getElementById("searchInput"),
  sync: document.getElementById("syncStatus"),
  menuBtn: document.getElementById("menuBtn"),
  menu: document.getElementById("menuPanel"),
  addBtn: document.getElementById("addBtn"),
  modal: document.getElementById("modal"),
  form: document.getElementById("productForm"),
  formTitle: document.getElementById("formTitle"),
  cancelBtn: document.getElementById("cancelBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  photoInput: document.getElementById("photoInput"),
  photoPreview: document.getElementById("photoPreview"),
  nameInput: document.getElementById("nameInput"),
  qtyInput: document.getElementById("qtyInput"),
  perBoxInput: document.getElementById("perBoxInput"),
  totalHint: document.getElementById("totalHint"),
  expiresInput: document.getElementById("expiresInput"),
  importInput: document.getElementById("importInput"),
  toast: document.getElementById("toast"),
};

let db;
let products = [];
let photoUrls = new Map();
let pendingPhotoBlob = null;
let editingId = null;
let saveTimer = null;
let toastTimer = null;

function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDaysISO(days) {
  const d = new Date(`${todayISO()}T00:00:00`);
  d.setDate(d.getDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function expiryState(expiresAt) {
  if (!expiresAt) return "ok";
  if (expiresAt < todayISO()) return "expired";
  if (expiresAt <= addDaysISO(SOON_DAYS)) return "soon";
  return "ok";
}

function formatDate(iso) {
  if (!iso) return "Sem validade";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function expiryLabel(expiresAt) {
  const state = expiryState(expiresAt);
  if (state === "expired") return "Vencido";
  if (state === "soon") return "Vence em breve";
  return "No prazo";
}

function normalizePerBox(value) {
  return Math.max(1, Number.parseInt(value, 10) || 1);
}

function normalizeQuantity(value) {
  return Math.max(0, Number.parseInt(value, 10) || 0);
}

function productTotal(product) {
  return normalizeQuantity(product.quantity) * normalizePerBox(product.perBox);
}

function totalUnitsLabel(boxes, perBox) {
  const total = normalizeQuantity(boxes) * normalizePerBox(perBox);
  return total === 1 ? "1 unidade no total" : `${total} unidades no total`;
}

function updateTotalHint() {
  if (!els.totalHint) return;
  els.totalHint.textContent = totalUnitsLabel(els.qtyInput.value, els.perBoxInput.value);
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 2600);
}

function setSync(state, label) {
  els.sync.dataset.state = state;
  els.sync.textContent = label;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains("products")) {
        database.createObjectStore("products", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("photos")) {
        database.createObjectStore("photos", { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transação cancelada"));
  });
}

async function idbGetAllProducts() {
  return new Promise((resolve, reject) => {
    const req = db.transaction("products").objectStore("products").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetPhoto(id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("photos").objectStore("photos").get(id);
    req.onsuccess = () => resolve(req.result?.blob || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutProduct(product) {
  const tx = db.transaction("products", "readwrite");
  tx.objectStore("products").put(product);
  await txDone(tx);
}

async function idbPutPhoto(id, blob) {
  const tx = db.transaction("photos", "readwrite");
  tx.objectStore("photos").put({ id, blob });
  await txDone(tx);
}

async function idbDeleteProduct(id) {
  const tx = db.transaction(["products", "photos"], "readwrite");
  tx.objectStore("products").delete(id);
  tx.objectStore("photos").delete(id);
  await txDone(tx);
}

async function idbReplaceAll(nextProducts) {
  const tx = db.transaction("products", "readwrite");
  const store = tx.objectStore("products");
  store.clear();
  for (const product of nextProducts) store.put(product);
  await txDone(tx);
}

function revokePhotoUrl(id) {
  const url = photoUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    photoUrls.delete(id);
  }
}

async function rememberPhoto(id, blob) {
  if (!blob) return;
  await idbPutPhoto(id, blob);
  revokePhotoUrl(id);
  photoUrls.set(id, URL.createObjectURL(blob));
}

async function loadLocalPhotos(list) {
  await Promise.all(
    list
      .filter((p) => p.hasPhoto)
      .map(async (p) => {
        if (photoUrls.has(p.id)) return;
        const blob = await idbGetPhoto(p.id);
        if (blob) photoUrls.set(p.id, URL.createObjectURL(blob));
      }),
  );
}

function sortProducts(list) {
  return [...list].sort((a, b) => {
    const ae = a.expiresAt || "9999-12-31";
    const be = b.expiresAt || "9999-12-31";
    if (ae !== be) return ae.localeCompare(be);
    return a.name.localeCompare(b.name, "pt");
  });
}

function filteredProducts() {
  const q = els.search.value.trim().toLowerCase();
  const list = sortProducts(products);
  if (!q) return list;
  return list.filter((p) => p.name.toLowerCase().includes(q));
}

function render() {
  const list = filteredProducts();
  els.list.innerHTML = "";
  els.empty.hidden = list.length > 0;

  for (const product of list) {
    const state = expiryState(product.expiresAt);
    const li = document.createElement("li");
    li.className = `card ${state === "expired" ? "expired" : ""}`;
    const photoSrc = photoUrls.get(product.id);

    li.innerHTML = `
      ${
        photoSrc
          ? `<img class="card-photo" alt="" src="${photoSrc}" />`
          : `<div class="card-photo placeholder">Sem foto</div>`
      }
      <div class="card-body">
        <div class="card-top">
          <h2 class="card-name"></h2>
          <span class="badge ${state}">${expiryLabel(product.expiresAt)}</span>
        </div>
        <p class="expires">Validade ${formatDate(product.expiresAt)}</p>
        <p class="box-meta">${normalizePerBox(product.perBox)} un/caixa · ${productTotal(product)} no total</p>
        <div class="card-row">
          <div>
            <span class="stepper-label">Caixas</span>
            <div class="stepper">
              <button type="button" class="step-btn" data-act="minus" aria-label="Diminuir caixas">−</button>
              <span class="qty">${product.quantity}</span>
              <button type="button" class="step-btn" data-act="plus" aria-label="Aumentar caixas">+</button>
            </div>
          </div>
          <div class="card-actions">
            <button type="button" class="card-btn" data-act="edit" aria-label="Editar">✎</button>
          </div>
        </div>
      </div>
    `;
    li.querySelector(".card-name").textContent = product.name;
    li.querySelector("[data-act='minus']").addEventListener("click", () => changeQty(product.id, -1));
    li.querySelector("[data-act='plus']").addEventListener("click", () => changeQty(product.id, 1));
    li.querySelector("[data-act='edit']").addEventListener("click", () => openModal(product.id));
    els.list.append(li);
  }
}

async function changeQty(id, delta) {
  const product = products.find((p) => p.id === id);
  if (!product) return;
  product.quantity = Math.max(0, product.quantity + delta);
  await idbPutProduct(product);
  render();
  queueCatalogSync();
}

function closeMenu() {
  els.menu.hidden = true;
  els.menuBtn.setAttribute("aria-expanded", "false");
}

function setPreview(blob) {
  if (blob) {
    const url = URL.createObjectURL(blob);
    els.photoPreview.style.backgroundImage = `url("${url}")`;
    els.photoPreview.innerHTML = "";
  } else {
    els.photoPreview.style.backgroundImage = "";
    els.photoPreview.innerHTML = `<span class="photo-hint"><strong>Tirar foto</strong><small>Toque para abrir a câmera</small></span>`;
  }
}

function openModal(id = null) {
  closeMenu();
  editingId = id;
  pendingPhotoBlob = null;
  els.photoInput.value = "";
  const product = products.find((p) => p.id === id);
  els.formTitle.textContent = product ? "Editar produto" : "Novo produto";
  els.nameInput.value = product?.name || "";
  els.qtyInput.value = product ? String(product.quantity) : "1";
  els.perBoxInput.value = product ? String(normalizePerBox(product.perBox)) : "1";
  els.expiresInput.value = product?.expiresAt || "";
  updateTotalHint();
  els.deleteBtn.hidden = !product;
  const existing = id ? photoUrls.get(id) : null;
  if (existing) {
    els.photoPreview.style.backgroundImage = `url("${existing}")`;
    els.photoPreview.innerHTML = "";
  } else {
    setPreview(null);
  }
  els.modal.hidden = false;
  document.body.style.overflow = "hidden";
  els.nameInput.focus();
}

function closeModal() {
  els.modal.hidden = true;
  document.body.style.overflow = "";
  editingId = null;
  pendingPhotoBlob = null;
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const max = 800;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.82);
  });
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let message = "Não foi possível falar com o servidor.";
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  const type = res.headers.get("content-type") || "";
  if (type.includes("application/json")) return res.json();
  return res.blob();
}

async function pushCatalog() {
  setSync("syncing", "A sincronizar…");
  try {
    await api("/api/products", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ products }),
    });
    setSync("saved", "Salvo no Drive");
  } catch (e) {
    setSync(navigator.onLine ? "error" : "offline", navigator.onLine ? "Falha no Drive" : "Sem internet");
    throw e;
  }
}

function queueCatalogSync() {
  clearTimeout(saveTimer);
  setSync("syncing", "A sincronizar…");
  saveTimer = setTimeout(async () => {
    try {
      await pushCatalog();
    } catch (e) {
      showToast(e.message);
    }
  }, 900);
}

async function uploadPhoto(id, blob) {
  await api(`/api/products/${encodeURIComponent(id)}/photo`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/jpeg" },
    body: blob,
  });
}

async function fetchMissingPhotos(list) {
  const missing = list.filter((p) => p.hasPhoto && !photoUrls.has(p.id));
  await Promise.all(
    missing.map(async (p) => {
      try {
        const blob = await api(`/api/photos/${encodeURIComponent(p.id)}`);
        await rememberPhoto(p.id, blob);
      } catch {
        /* foto pode ainda não existir */
      }
    }),
  );
}

async function pullFromDrive() {
  setSync("syncing", "A sincronizar…");
  const catalog = await api("/api/products");
  products = (Array.isArray(catalog.products) ? catalog.products : []).map((p) => ({
    ...p,
    quantity: normalizeQuantity(p.quantity),
    perBox: normalizePerBox(p.perBox),
  }));
  await idbReplaceAll(products);
  await fetchMissingPhotos(products);
  setSync("saved", "Salvo no Drive");
}

async function saveForm(event) {
  event.preventDefault();
  const name = els.nameInput.value.trim();
  const quantity = normalizeQuantity(els.qtyInput.value);
  const perBox = normalizePerBox(els.perBoxInput.value);
  const expiresAt = els.expiresInput.value;
  if (!name || !expiresAt) {
    showToast("Preencha nome e validade.");
    return;
  }

  const id = editingId || crypto.randomUUID();
  const existing = products.find((p) => p.id === id);
  const hasPhoto = Boolean(pendingPhotoBlob || (existing?.hasPhoto && photoUrls.has(id)));
  const product = {
    id,
    name,
    quantity,
    perBox,
    expiresAt,
    hasPhoto,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };

  const photoToUpload = pendingPhotoBlob;
  if (photoToUpload) {
    await rememberPhoto(id, photoToUpload);
    product.hasPhoto = true;
  }

  const index = products.findIndex((p) => p.id === id);
  if (index >= 0) products[index] = product;
  else products.push(product);
  await idbPutProduct(product);
  closeModal();
  render();

  try {
    if (photoToUpload) await uploadPhoto(id, photoToUpload);
    await pushCatalog();
  } catch (e) {
    showToast(e.message);
  }
}

async function deleteCurrent() {
  if (!editingId) return;
  if (!confirm("Excluir este produto?")) return;
  const id = editingId;
  products = products.filter((p) => p.id !== id);
  await idbDeleteProduct(id);
  revokePhotoUrl(id);
  closeModal();
  render();
  try {
    await api(`/api/products/${encodeURIComponent(id)}/photo`, { method: "DELETE" });
    await pushCatalog();
  } catch (e) {
    showToast(e.message);
  }
}

function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

async function exportJson() {
  closeMenu();
  const payload = {
    exportedAt: new Date().toISOString(),
    products: await Promise.all(
      products.map(async (p) => {
        const blob = p.hasPhoto ? await idbGetPhoto(p.id) : null;
        return {
          ...p,
          photo: blob ? await blobToDataUrl(blob) : null,
        };
      }),
    ),
  };
  downloadFile(`catalogo-${todayISO()}.json`, JSON.stringify(payload, null, 2), "application/json");
  showToast("JSON exportado.");
}

function exportCsv() {
  closeMenu();
  const lines = ["Nome,Caixas,Un. por caixa,Total,Validade"];
  for (const p of sortProducts(products)) {
    lines.push(
      [csvEscape(p.name), p.quantity, normalizePerBox(p.perBox), productTotal(p), p.expiresAt].join(","),
    );
  }
  downloadFile(`catalogo-${todayISO()}.csv`, `${lines.join("\n")}\n`, "text/csv;charset=utf-8");
  showToast("CSV exportado.");
}

function dataUrlToBlob(dataUrl) {
  const [meta, data] = dataUrl.split(",");
  const mime = meta.match(/data:([^;]+)/)?.[1] || "image/jpeg";
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function importJson(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast("JSON inválido.");
    return;
  }
  const incoming = Array.isArray(data) ? data : data.products;
  if (!Array.isArray(incoming) || !incoming.length) {
    showToast("Nenhum produto no arquivo.");
    return;
  }

  for (const item of incoming) {
    const id = crypto.randomUUID();
    const product = {
      id,
      name: String(item.name || "").trim(),
      quantity: normalizeQuantity(item.quantity),
      perBox: normalizePerBox(item.perBox),
      expiresAt: String(item.expiresAt || "").slice(0, 10),
      hasPhoto: false,
      createdAt: new Date().toISOString(),
    };
    if (!product.name || !product.expiresAt) continue;
    if (item.photo && String(item.photo).startsWith("data:")) {
      const blob = dataUrlToBlob(item.photo);
      await rememberPhoto(id, blob);
      product.hasPhoto = true;
      try {
        await uploadPhoto(id, blob);
      } catch {
        /* continua local se o Drive falhar */
      }
    }
    products.push(product);
    await idbPutProduct(product);
  }
  render();
  try {
    await pushCatalog();
  } catch (e) {
    showToast(e.message);
  }
  showToast("Produtos importados.");
}

els.menuBtn.addEventListener("click", () => {
  const open = els.menu.hidden;
  els.menu.hidden = !open;
  els.menuBtn.setAttribute("aria-expanded", String(open));
});

document.getElementById("exportJsonBtn").addEventListener("click", () => {
  exportJson().catch((e) => showToast(e.message));
});
document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
document.getElementById("importBtn").addEventListener("click", () => {
  closeMenu();
  els.importInput.click();
});
document.getElementById("syncNowBtn").addEventListener("click", async () => {
  closeMenu();
  try {
    await pullFromDrive();
    await loadLocalPhotos(products);
    render();
    showToast("Catálogo atualizado.");
  } catch (e) {
    showToast(e.message);
  }
});

els.importInput.addEventListener("change", async () => {
  const file = els.importInput.files?.[0];
  els.importInput.value = "";
  if (file) await importJson(file);
});

els.addBtn.addEventListener("click", () => openModal());
els.cancelBtn.addEventListener("click", closeModal);
els.deleteBtn.addEventListener("click", () => {
  deleteCurrent().catch((e) => showToast(e.message));
});
els.form.addEventListener("submit", (event) => {
  saveForm(event).catch((e) => showToast(e.message));
});
els.search.addEventListener("input", render);
els.qtyInput.addEventListener("input", updateTotalHint);
els.perBoxInput.addEventListener("input", updateTotalHint);
els.photoInput.addEventListener("change", async () => {
  const file = els.photoInput.files?.[0];
  if (!file) return;
  pendingPhotoBlob = await resizeImage(file);
  setPreview(pendingPhotoBlob);
});

document.addEventListener("click", (event) => {
  if (!els.menu.hidden && !els.menu.contains(event.target) && event.target !== els.menuBtn) {
    closeMenu();
  }
});

window.addEventListener("online", () => {
  pullFromDrive()
    .then(() => loadLocalPhotos(products))
    .then(render)
    .catch(() => setSync("offline", "Sem internet"));
});

window.addEventListener("offline", () => setSync("offline", "Sem internet"));

async function init() {
  db = await openDb();
  products = (await idbGetAllProducts()).map((p) => ({
    ...p,
    quantity: normalizeQuantity(p.quantity),
    perBox: normalizePerBox(p.perBox),
  }));
  await loadLocalPhotos(products);
  render();
  if (!navigator.onLine) {
    setSync("offline", "Sem internet");
    return;
  }
  try {
    await pullFromDrive();
    await loadLocalPhotos(products);
    render();
  } catch (e) {
    setSync(products.length ? "offline" : "error", products.length ? "Sem internet" : "Falha no Drive");
    if (!products.length) showToast(e.message);
  }
}

init().catch((e) => {
  setSync("error", "Erro");
  showToast(e.message);
});

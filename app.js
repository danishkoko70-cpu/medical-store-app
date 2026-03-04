import { Auth, db, FS } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const routeContent = $("routeContent");

const toastEl = $("appToast");
const toastBody = $("toastBody");
const toast = toastEl ? new bootstrap.Toast(toastEl, { delay: 2200 }) : null;

function notify(msg){
  if(toast){
    toastBody.textContent = msg;
    toast.show();
  } else {
    alert(msg);
  }
}

function fmtDate(d){
  if(!d) return "";
  const x = (d instanceof Date) ? d : new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth()+1).padStart(2,"0");
  const day = String(x.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function parseDate(s){
  if(!s) return null;
  const d = new Date(s+"T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}
function money(n){
  const x = Number(n || 0);
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function setActiveNav(){
  const hash = location.hash || "#/dashboard";
  const links = document.querySelectorAll("#navLinks a, #navLinksMobile a");
  links.forEach(a=>{
    a.classList.toggle("active", a.getAttribute("href") === hash);
  });
}

function cardRow(title, value, sub=""){
  return `
  <div class="col-12 col-md-6 col-xl-3">
    <div class="card p-3">
      <div class="small-muted">${title}</div>
      <div class="fs-4 fw-bold">${value}</div>
      <div class="small-muted">${sub}</div>
    </div>
  </div>`;
}

async function ensureSettings(uid){
  const ref = FS.doc(db, "settings", "main");
  const snap = await FS.getDoc(ref);
  if(!snap.exists()){
    await FS.setDoc(ref, {
      storeName: "My Medical Store",
      phone: "",
      address: "",
      expiryAlertDays: 30,
      lowStockDefault: 10,
      currency: "PKR",
      createdAt: FS.serverTimestamp(),
      createdBy: uid
    });
  }
}

async function getSettings(){
  const ref = FS.doc(db, "settings", "main");
  const snap = await FS.getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

// ---------- Data operations ----------

async function upsertMedicine({ id, name, company, salt, unit, barcode, sellingPrice, reorderLevel, notes }){
  const ref = id ? FS.doc(db, "medicines", id) : null;

  const payload = {
    name: name.trim(),
    company: (company||"").trim(),
    salt: (salt||"").trim(),
    unit: (unit||"").trim(),
    barcode: (barcode||"").trim(),
    sellingPrice: Number(sellingPrice||0),
    reorderLevel: Number(reorderLevel||0),
    notes: (notes||"").trim(),
    updatedAt: FS.serverTimestamp(),
  };

  if(ref){
    await FS.updateDoc(ref, payload);
    return id;
  } else {
    payload.createdAt = FS.serverTimestamp();
    const added = await FS.addDoc(FS.collection(db,"medicines"), payload);
    return added.id;
  }
}

async function addBatch({ medicineId, batchNo, expiryDate, qty, purchasePrice, supplierId, invoiceNo, purchaseDate }){
  const payload = {
    medicineId,
    batchNo: (batchNo||"").trim(),
    expiryDate: expiryDate ? fmtDate(expiryDate) : "",
    qty: Number(qty||0),
    purchasePrice: Number(purchasePrice||0),
    supplierId: supplierId || "",
    invoiceNo: (invoiceNo||"").trim(),
    purchaseDate: purchaseDate ? fmtDate(purchaseDate) : fmtDate(new Date()),
    createdAt: FS.serverTimestamp()
  };
  const added = await FS.addDoc(FS.collection(db,"batches"), payload);
  return added.id;
}

async function recordPurchase({ supplierId, invoiceNo, date, items, paid=0 }){
  // items: [{medicineId, batchNo, expiryDate, qty, purchasePrice}]
  const payload = {
    supplierId: supplierId || "",
    invoiceNo: (invoiceNo||"").trim(),
    date: fmtDate(date || new Date()),
    items,
    total: items.reduce((a,it)=> a + Number(it.qty||0)*Number(it.purchasePrice||0), 0),
    paid: Number(paid||0),
    createdAt: FS.serverTimestamp()
  };
  const added = await FS.addDoc(FS.collection(db,"purchases"), payload);

  // create batches
  for(const it of items){
    await addBatch({
      medicineId: it.medicineId,
      batchNo: it.batchNo,
      expiryDate: parseDate(it.expiryDate),
      qty: it.qty,
      purchasePrice: it.purchasePrice,
      supplierId,
      invoiceNo,
      purchaseDate: parseDate(payload.date)
    });
  }

  return added.id;
}

async function recordSale({ customerId, date, items, discount=0, paid=0 }){
  // items: [{medicineId, qty, sellingPrice}]
  // Deduct stock from earliest-expiry batches (FEFO) using a transaction
  const saleDocRef = FS.doc(FS.collection(db,"sales"));
  const saleDateStr = fmtDate(date || new Date());

  await FS.runTransaction(db, async (tx) => {
    // For each medicine, deduct qty from batches orderBy expiryDate asc
    for(const it of items){
      const need = Number(it.qty||0);
      if(need <= 0) continue;

      const qB = FS.query(
        FS.collection(db, "batches"),
        FS.where("medicineId","==", it.medicineId),
        FS.where("qty", ">", 0),
        FS.orderBy("qty"), // workaround to allow > with another orderBy in some cases; then manual sort
        FS.limit(50)
      );

      const snap = await FS.getDocs(qB);
      const batches = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      batches.sort((a,b)=>{
        const ea = a.expiryDate || "9999-12-31";
        const eb = b.expiryDate || "9999-12-31";
        return ea.localeCompare(eb);
      });

      let remaining = need;
      for(const b of batches){
        if(remaining <= 0) break;
        const take = Math.min(remaining, Number(b.qty||0));
        if(take <= 0) continue;

        const bref = FS.doc(db, "batches", b.id);
        tx.update(bref, { qty: Number(b.qty||0) - take });
        remaining -= take;
      }

      if(remaining > 0){
        throw new Error("Stock کم ہے۔ پہلے Purchase کے ذریعے stock add کریں۔");
      }
    }

    const total = items.reduce((a,it)=> a + Number(it.qty||0)*Number(it.sellingPrice||0), 0);
    const net = Math.max(0, total - Number(discount||0));
    tx.set(saleDocRef, {
      customerId: customerId || "",
      date: saleDateStr,
      items,
      total,
      discount: Number(discount||0),
      net,
      paid: Number(paid||0),
      createdAt: FS.serverTimestamp()
    });
  });

  return saleDocRef.id;
}

// ---------- UI / Routes ----------

function tplHeader(title, rightHtml=""){
  return `
  <div class="d-flex flex-wrap align-items-center gap-2 mb-3">
    <div>
      <h3 class="mb-0">${title}</h3>
    </div>
    <div class="ms-auto d-flex gap-2">
      ${rightHtml}
    </div>
  </div>`;
}

function tplEmpty(msg){
  return `<div class="alert alert-light border">${msg}</div>`;
}

async function routeDashboard(){
  const settings = await getSettings();
  const alertDays = Number(settings?.expiryAlertDays ?? 30);
  const today = new Date();
  const until = new Date(today.getTime() + alertDays*24*3600*1000);
  const untilStr = fmtDate(until);

  // Expiring batches
  const qExp = FS.query(
    FS.collection(db,"batches"),
    FS.where("qty", ">", 0),
    FS.where("expiryDate", "<=", untilStr),
    FS.orderBy("expiryDate"),
    FS.limit(50)
  );

  // Low stock: compute via aggregation in client (sum batches per medicine)
  const medSnap = await FS.getDocs(FS.query(FS.collection(db,"medicines"), FS.orderBy("name"), FS.limit(200)));
  const meds = medSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const batchSnap = await FS.getDocs(FS.query(FS.collection(db,"batches"), FS.where("qty",">",0), FS.limit(500)));
  const batches = batchSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const stockByMed = new Map();
  for(const b of batches){
    stockByMed.set(b.medicineId, (stockByMed.get(b.medicineId)||0) + Number(b.qty||0));
  }

  const low = meds
    .map(m=>({ ...m, stock: stockByMed.get(m.id)||0 }))
    .filter(m=> m.reorderLevel > 0 && m.stock <= m.reorderLevel)
    .slice(0, 50);

  const expSnap = await FS.getDocs(qExp);
  const exp = expSnap.docs.map(d=>({id:d.id, ...d.data()}));

  // today sales total
  const todayStr = fmtDate(today);
  const salesSnap = await FS.getDocs(FS.query(FS.collection(db,"sales"), FS.where("date","==", todayStr), FS.limit(200)));
  const sales = salesSnap.docs.map(d=>d.data());
  const todaySales = sales.reduce((a,s)=>a + Number(s.net||0),0);

  const purchasesSnap = await FS.getDocs(FS.query(FS.collection(db,"purchases"), FS.where("date","==", todayStr), FS.limit(200)));
  const purchases = purchasesSnap.docs.map(d=>d.data());
  const todayPurch = purchases.reduce((a,p)=>a + Number(p.total||0),0);

  routeContent.innerHTML = `
    ${tplHeader("Dashboard",
      `<a class="btn btn-primary" href="#/sales">New Sale</a>
       <a class="btn btn-outline-primary" href="#/purchases">New Purchase</a>`)}
    <div class="row g-3 mb-3">
      ${cardRow("Today Sales", money(todaySales), settings?.currency || "PKR")}
      ${cardRow("Today Purchases", money(todayPurch), settings?.currency || "PKR")}
      ${cardRow("Expiry Alerts", `${exp.length}`, `Next ${alertDays} days`)}
      ${cardRow("Low Stock", `${low.length}`, "Reorder needed")}
    </div>

    <div class="row g-3">
      <div class="col-12 col-lg-7">
        <div class="card p-3">
          <div class="d-flex align-items-center mb-2">
            <div class="fw-semibold">Expiry Alerts (Batches)</div>
            <div class="ms-auto small-muted">≤ ${untilStr}</div>
          </div>
          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Expiry</th><th>Batch</th><th>Medicine</th><th class="text-end">Qty</th></tr></thead>
              <tbody>
                ${exp.length ? exp.map(b=>`
                  <tr>
                    <td class="mono">${b.expiryDate || "-"}</td>
                    <td>${b.batchNo || "-"}</td>
                    <td class="mono">${b.medicineId}</td>
                    <td class="text-end fw-semibold">${money(b.qty)}</td>
                  </tr>`).join("") : `<tr><td colspan="4">${tplEmpty("کوئی expiry alert نہیں")}</td></tr>`}
              </tbody>
            </table>
            <div class="small-muted">Note: Medicine name view کیلئے Inventory list use کریں (آگے version میں join بھی کر دیں گے)</div>
          </div>
        </div>
      </div>
      <div class="col-12 col-lg-5">
        <div class="card p-3">
          <div class="fw-semibold mb-2">Low Stock</div>
          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Medicine</th><th class="text-end">Stock</th><th class="text-end">Reorder</th></tr></thead>
              <tbody>
                ${low.length ? low.map(m=>`
                  <tr>
                    <td>${m.name}</td>
                    <td class="text-end fw-semibold">${money(m.stock)}</td>
                    <td class="text-end">${money(m.reorderLevel)}</td>
                  </tr>`).join("") : `<tr><td colspan="3">${tplEmpty("کوئی low stock alert نہیں")}</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function routeInventory(){
  const medsSnap = await FS.getDocs(FS.query(FS.collection(db,"medicines"), FS.orderBy("name"), FS.limit(500)));
  const meds = medsSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const batchSnap = await FS.getDocs(FS.query(FS.collection(db,"batches"), FS.where("qty",">",0), FS.limit(2000)));
  const batches = batchSnap.docs.map(d=>({id:d.id, ...d.data()}));
  const stockByMed = new Map();
  for(const b of batches){
    stockByMed.set(b.medicineId, (stockByMed.get(b.medicineId)||0) + Number(b.qty||0));
  }

  routeContent.innerHTML = `
    ${tplHeader("Inventory",
      `<button class="btn btn-primary" id="btnNewMed">+ Add Medicine</button>`)}
    <div class="card p-3">
      <div class="row g-2 mb-2">
        <div class="col-12 col-md-6">
          <input class="form-control" id="medSearch" placeholder="Search medicine name / company / barcode...">
        </div>
        <div class="col-12 col-md-6 d-flex gap-2">
          <button class="btn btn-outline-secondary" id="btnExportMeds">Export CSV</button>
          <a class="btn btn-outline-primary ms-auto" href="#/purchases">Add Stock (Purchase)</a>
        </div>
      </div>

      <div class="table-responsive">
        <table class="table table-sm align-middle">
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th class="text-end">Sell</th>
              <th class="text-end">Stock</th>
              <th class="text-end">Reorder</th>
              <th class="text-end">Action</th>
            </tr>
          </thead>
          <tbody id="medRows">
            ${meds.map(m=>{
              const stock = stockByMed.get(m.id)||0;
              return `<tr data-id="${m.id}">
                <td class="fw-semibold">${m.name}</td>
                <td>${m.company||""}</td>
                <td class="text-end">${money(m.sellingPrice)}</td>
                <td class="text-end ${stock <= (m.reorderLevel||0) && (m.reorderLevel||0)>0 ? "text-danger fw-bold":""}">${money(stock)}</td>
                <td class="text-end">${money(m.reorderLevel||0)}</td>
                <td class="text-end">
                  <button class="btn btn-sm btn-outline-primary btnEditMed">Edit</button>
                  <button class="btn btn-sm btn-outline-danger btnDelMed">Del</button>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      ${meds.length ? "" : tplEmpty("ابھی کوئی medicine add نہیں کی گئی")}
    </div>

    <!-- Modal -->
    <div class="modal fade" id="medModal" tabindex="-1">
      <div class="modal-dialog modal-lg">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title" id="medModalTitle">Add Medicine</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <input type="hidden" id="medId">
            <div class="row g-2">
              <div class="col-12 col-md-6">
                <label class="form-label">Medicine Name *</label>
                <input class="form-control" id="medName">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Company</label>
                <input class="form-control" id="medCompany">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Salt/Formula</label>
                <input class="form-control" id="medSalt">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Unit (e.g. Tab/Cap/Syrup)</label>
                <input class="form-control" id="medUnit">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Barcode</label>
                <input class="form-control" id="medBarcode">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Selling Price</label>
                <input class="form-control" id="medSell" type="number" step="0.01">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Reorder Level</label>
                <input class="form-control" id="medReorder" type="number" step="1">
              </div>
              <div class="col-12 col-md-6">
                <label class="form-label">Notes</label>
                <input class="form-control" id="medNotes">
              </div>
            </div>
            <div class="form-text mt-2">Stock/Expiry batches Purchases میں add ہوں گے۔</div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-primary" id="btnSaveMed">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // modal setup
  const modalEl = $("medModal");
  const modal = new bootstrap.Modal(modalEl);

  $("btnNewMed").onclick = async () => {
    $("medModalTitle").textContent = "Add Medicine";
    $("medId").value = "";
    ["medName","medCompany","medSalt","medUnit","medBarcode","medSell","medReorder","medNotes"].forEach(id=> $(id).value = "");
    modal.show();
  };

  $("btnSaveMed").onclick = async () => {
    const name = $("medName").value.trim();
    if(!name) return notify("Medicine name ضروری ہے");
    const id = $("medId").value || null;

    await upsertMedicine({
      id,
      name,
      company: $("medCompany").value,
      salt: $("medSalt").value,
      unit: $("medUnit").value,
      barcode: $("medBarcode").value,
      sellingPrice: $("medSell").value,
      reorderLevel: $("medReorder").value,
      notes: $("medNotes").value
    });

    modal.hide();
    notify("Saved");
    routeInventory();
  };

  // edit/delete handlers
  document.querySelectorAll(".btnEditMed").forEach(btn=>{
    btn.onclick = () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      const m = meds.find(x=>x.id===id);
      $("medModalTitle").textContent = "Edit Medicine";
      $("medId").value = id;
      $("medName").value = m.name||"";
      $("medCompany").value = m.company||"";
      $("medSalt").value = m.salt||"";
      $("medUnit").value = m.unit||"";
      $("medBarcode").value = m.barcode||"";
      $("medSell").value = m.sellingPrice||0;
      $("medReorder").value = m.reorderLevel||0;
      $("medNotes").value = m.notes||"";
      modal.show();
    };
  });

  document.querySelectorAll(".btnDelMed").forEach(btn=>{
    btn.onclick = async () => {
      const tr = btn.closest("tr");
      const id = tr.dataset.id;
      if(!confirm("Delete this medicine?")) return;
      await FS.deleteDoc(FS.doc(db,"medicines", id));
      notify("Deleted");
      routeInventory();
    };
  });

  $("medSearch").oninput = () => {
    const q = $("medSearch").value.toLowerCase().trim();
    document.querySelectorAll("#medRows tr").forEach(tr=>{
      const id = tr.dataset.id;
      const m = meds.find(x=>x.id===id);
      const hay = `${m.name||""} ${m.company||""} ${m.barcode||""}`.toLowerCase();
      tr.classList.toggle("d-none", q && !hay.includes(q));
    });
  };

  $("btnExportMeds").onclick = () => {
    const rows = [["id","name","company","salt","unit","barcode","sellingPrice","reorderLevel","notes"]];
    meds.forEach(m=>{
      rows.push([m.id, m.name||"", m.company||"", m.salt||"", m.unit||"", m.barcode||"", m.sellingPrice||0, m.reorderLevel||0, m.notes||""]);
    });
    downloadCSV("medicines.csv", rows);
  };
}

async function routeSuppliers(){
  const snap = await FS.getDocs(FS.query(FS.collection(db,"suppliers"), FS.orderBy("name"), FS.limit(500)));
  const list = snap.docs.map(d=>({id:d.id, ...d.data()}));

  routeContent.innerHTML = `
    ${tplHeader("Suppliers", `<button class="btn btn-primary" id="btnNew">+ Add</button>`)}
    <div class="card p-3">
      <div class="table-responsive">
        <table class="table table-sm align-middle">
          <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th class="text-end">Action</th></tr></thead>
          <tbody>
            ${list.map(s=>`
              <tr data-id="${s.id}">
                <td class="fw-semibold">${s.name||""}</td>
                <td>${s.phone||""}</td>
                <td>${s.address||""}</td>
                <td class="text-end">
                  <button class="btn btn-sm btn-outline-primary btnEdit">Edit</button>
                  <button class="btn btn-sm btn-outline-danger btnDel">Del</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
        ${list.length ? "" : tplEmpty("No suppliers yet")}
      </div>
    </div>

    <div class="modal fade" id="modal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header"><h5 class="modal-title" id="mTitle">Add Supplier</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
          <div class="modal-body">
            <input type="hidden" id="mid">
            <label class="form-label">Name *</label>
            <input class="form-control mb-2" id="mName">
            <label class="form-label">Phone</label>
            <input class="form-control mb-2" id="mPhone">
            <label class="form-label">Address</label>
            <input class="form-control" id="mAddr">
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-primary" id="mSave">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const modal = new bootstrap.Modal($("modal"));

  $("btnNew").onclick = ()=>{
    $("mTitle").textContent = "Add Supplier";
    $("mid").value="";
    $("mName").value="";
    $("mPhone").value="";
    $("mAddr").value="";
    modal.show();
  };

  $("mSave").onclick = async ()=>{
    const name = $("mName").value.trim();
    if(!name) return notify("Name required");
    const id = $("mid").value;
    const payload = { name, phone:$("mPhone").value.trim(), address:$("mAddr").value.trim(), updatedAt: FS.serverTimestamp() };
    if(id){
      await FS.updateDoc(FS.doc(db,"suppliers",id), payload);
    } else {
      payload.createdAt = FS.serverTimestamp();
      await FS.addDoc(FS.collection(db,"suppliers"), payload);
    }
    modal.hide();
    notify("Saved");
    routeSuppliers();
  };

  document.querySelectorAll(".btnEdit").forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.closest("tr").dataset.id;
      const s = list.find(x=>x.id===id);
      $("mTitle").textContent = "Edit Supplier";
      $("mid").value=id;
      $("mName").value=s.name||"";
      $("mPhone").value=s.phone||"";
      $("mAddr").value=s.address||"";
      modal.show();
    };
  });

  document.querySelectorAll(".btnDel").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.closest("tr").dataset.id;
      if(!confirm("Delete supplier?")) return;
      await FS.deleteDoc(FS.doc(db,"suppliers", id));
      notify("Deleted");
      routeSuppliers();
    };
  });
}

async function routeCustomers(){
  const snap = await FS.getDocs(FS.query(FS.collection(db,"customers"), FS.orderBy("name"), FS.limit(500)));
  const list = snap.docs.map(d=>({id:d.id, ...d.data()}));

  routeContent.innerHTML = `
    ${tplHeader("Customers", `<button class="btn btn-primary" id="btnNew">+ Add</button>`)}
    <div class="card p-3">
      <div class="table-responsive">
        <table class="table table-sm align-middle">
          <thead><tr><th>Name</th><th>Phone</th><th>Address</th><th class="text-end">Action</th></tr></thead>
          <tbody>
            ${list.map(s=>`
              <tr data-id="${s.id}">
                <td class="fw-semibold">${s.name||""}</td>
                <td>${s.phone||""}</td>
                <td>${s.address||""}</td>
                <td class="text-end">
                  <button class="btn btn-sm btn-outline-primary btnEdit">Edit</button>
                  <button class="btn btn-sm btn-outline-danger btnDel">Del</button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
        ${list.length ? "" : tplEmpty("No customers yet")}
      </div>
    </div>

    <div class="modal fade" id="modal" tabindex="-1">
      <div class="modal-dialog">
        <div class="modal-content">
          <div class="modal-header"><h5 class="modal-title" id="mTitle">Add Customer</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button></div>
          <div class="modal-body">
            <input type="hidden" id="mid">
            <label class="form-label">Name *</label>
            <input class="form-control mb-2" id="mName">
            <label class="form-label">Phone</label>
            <input class="form-control mb-2" id="mPhone">
            <label class="form-label">Address</label>
            <input class="form-control" id="mAddr">
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button class="btn btn-primary" id="mSave">Save</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const modal = new bootstrap.Modal($("modal"));

  $("btnNew").onclick = ()=>{
    $("mTitle").textContent = "Add Customer";
    $("mid").value="";
    $("mName").value="";
    $("mPhone").value="";
    $("mAddr").value="";
    modal.show();
  };

  $("mSave").onclick = async ()=>{
    const name = $("mName").value.trim();
    if(!name) return notify("Name required");
    const id = $("mid").value;
    const payload = { name, phone:$("mPhone").value.trim(), address:$("mAddr").value.trim(), updatedAt: FS.serverTimestamp() };
    if(id){
      await FS.updateDoc(FS.doc(db,"customers",id), payload);
    } else {
      payload.createdAt = FS.serverTimestamp();
      await FS.addDoc(FS.collection(db,"customers"), payload);
    }
    modal.hide();
    notify("Saved");
    routeCustomers();
  };

  document.querySelectorAll(".btnEdit").forEach(btn=>{
    btn.onclick = ()=>{
      const id = btn.closest("tr").dataset.id;
      const s = list.find(x=>x.id===id);
      $("mTitle").textContent = "Edit Customer";
      $("mid").value=id;
      $("mName").value=s.name||"";
      $("mPhone").value=s.phone||"";
      $("mAddr").value=s.address||"";
      modal.show();
    };
  });

  document.querySelectorAll(".btnDel").forEach(btn=>{
    btn.onclick = async ()=>{
      const id = btn.closest("tr").dataset.id;
      if(!confirm("Delete customer?")) return;
      await FS.deleteDoc(FS.doc(db,"customers", id));
      notify("Deleted");
      routeCustomers();
    };
  });
}

async function routePurchases(){
  const suppliersSnap = await FS.getDocs(FS.query(FS.collection(db,"suppliers"), FS.orderBy("name"), FS.limit(500)));
  const suppliers = suppliersSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const medsSnap = await FS.getDocs(FS.query(FS.collection(db,"medicines"), FS.orderBy("name"), FS.limit(2000)));
  const meds = medsSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const listSnap = await FS.getDocs(FS.query(FS.collection(db,"purchases"), FS.orderBy("date","desc"), FS.limit(50)));
  const purchases = listSnap.docs.map(d=>({id:d.id, ...d.data()}));

  routeContent.innerHTML = `
    ${tplHeader("Purchases")}
    <div class="row g-3">
      <div class="col-12 col-lg-6">
        <div class="card p-3">
          <div class="fw-semibold mb-2">New Purchase (Add Stock)</div>

          <div class="row g-2">
            <div class="col-12 col-md-6">
              <label class="form-label">Supplier</label>
              <select class="form-select" id="pSupplier">
                <option value="">(Optional)</option>
                ${suppliers.map(s=>`<option value="${s.id}">${s.name}</option>`).join("")}
              </select>
            </div>
            <div class="col-12 col-md-6">
              <label class="form-label">Invoice No</label>
              <input class="form-control" id="pInvoice" placeholder="INV-001">
            </div>
            <div class="col-12 col-md-6">
              <label class="form-label">Date</label>
              <input class="form-control" id="pDate" type="date" value="${fmtDate(new Date())}">
            </div>
            <div class="col-12 col-md-6">
              <label class="form-label">Paid</label>
              <input class="form-control" id="pPaid" type="number" step="0.01" value="0">
            </div>
          </div>

          <hr class="my-3"/>

          <div class="d-flex align-items-center mb-2">
            <div class="fw-semibold">Items</div>
            <button class="btn btn-sm btn-outline-primary ms-auto" id="btnAddItem">+ Add Item</button>
          </div>

          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th class="text-end">Qty</th><th class="text-end">Price</th><th></th></tr></thead>
              <tbody id="pItems"></tbody>
            </table>
          </div>

          <div class="d-flex align-items-center">
            <div class="fw-semibold">Total: <span id="pTotal">0</span></div>
            <button class="btn btn-primary ms-auto" id="btnSavePurchase">Save Purchase</button>
          </div>
        </div>
      </div>

      <div class="col-12 col-lg-6">
        <div class="card p-3">
          <div class="fw-semibold mb-2">Recent Purchases</div>
          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Date</th><th>Invoice</th><th class="text-end">Total</th></tr></thead>
              <tbody>
                ${purchases.map(p=>`
                  <tr>
                    <td class="mono">${p.date}</td>
                    <td>${p.invoiceNo||""}</td>
                    <td class="text-end fw-semibold">${money(p.total)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
            ${purchases.length ? "" : tplEmpty("No purchases yet")}
          </div>
        </div>
      </div>
    </div>
  `;

  const items = [];
  const renderItems = ()=>{
    const tbody = $("pItems");
    tbody.innerHTML = items.map((it, idx)=>{
      return `<tr>
        <td style="min-width:180px">
          <select class="form-select form-select-sm pMed" data-idx="${idx}">
            <option value="">Select</option>
            ${meds.map(m=>`<option value="${m.id}" ${m.id===it.medicineId?"selected":""}>${m.name}</option>`).join("")}
          </select>
        </td>
        <td><input class="form-control form-control-sm pBatch" data-idx="${idx}" value="${it.batchNo||""}" placeholder="B-01"></td>
        <td><input class="form-control form-control-sm pExp" data-idx="${idx}" type="date" value="${it.expiryDate||""}"></td>
        <td><input class="form-control form-control-sm pQty text-end" data-idx="${idx}" type="number" step="1" value="${it.qty||0}"></td>
        <td><input class="form-control form-control-sm pPrice text-end" data-idx="${idx}" type="number" step="0.01" value="${it.purchasePrice||0}"></td>
        <td class="text-end"><button class="btn btn-sm btn-outline-danger pDel" data-idx="${idx}">×</button></td>
      </tr>`;
    }).join("");

    // bind
    tbody.querySelectorAll(".pMed").forEach(el=> el.onchange = ()=>{ items[el.dataset.idx].medicineId = el.value; calc(); });
    tbody.querySelectorAll(".pBatch").forEach(el=> el.oninput = ()=>{ items[el.dataset.idx].batchNo = el.value; });
    tbody.querySelectorAll(".pExp").forEach(el=> el.onchange = ()=>{ items[el.dataset.idx].expiryDate = el.value; });
    tbody.querySelectorAll(".pQty").forEach(el=> el.oninput = ()=>{ items[el.dataset.idx].qty = Number(el.value||0); calc(); });
    tbody.querySelectorAll(".pPrice").forEach(el=> el.oninput = ()=>{ items[el.dataset.idx].purchasePrice = Number(el.value||0); calc(); });
    tbody.querySelectorAll(".pDel").forEach(el=> el.onclick = ()=>{ items.splice(el.dataset.idx,1); renderItems(); calc(); });

    calc();
  };

  const calc = ()=>{
    const total = items.reduce((a,it)=> a + Number(it.qty||0)*Number(it.purchasePrice||0), 0);
    $("pTotal").textContent = money(total);
  };

  $("btnAddItem").onclick = ()=>{
    items.push({ medicineId:"", batchNo:"", expiryDate:"", qty:1, purchasePrice:0 });
    renderItems();
  };

  // start one item
  items.push({ medicineId:"", batchNo:"", expiryDate:"", qty:1, purchasePrice:0 });
  renderItems();

  $("btnSavePurchase").onclick = async ()=>{
    const date = parseDate($("pDate").value) || new Date();
    const supplierId = $("pSupplier").value || "";
    const invoiceNo = $("pInvoice").value.trim();
    const paid = Number($("pPaid").value||0);

    const clean = items
      .filter(it=> it.medicineId && Number(it.qty||0)>0)
      .map(it=> ({
        medicineId: it.medicineId,
        batchNo: it.batchNo || "",
        expiryDate: it.expiryDate || "",
        qty: Number(it.qty||0),
        purchasePrice: Number(it.purchasePrice||0)
      }));

    if(!clean.length) return notify("کم از کم 1 item ضروری ہے");

    await recordPurchase({ supplierId, invoiceNo, date, items: clean, paid });
    notify("Purchase saved (stock added)");
    location.hash = "#/dashboard";
  };
}

async function routeSales(){
  const customersSnap = await FS.getDocs(FS.query(FS.collection(db,"customers"), FS.orderBy("name"), FS.limit(500)));
  const customers = customersSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const medsSnap = await FS.getDocs(FS.query(FS.collection(db,"medicines"), FS.orderBy("name"), FS.limit(2000)));
  const meds = medsSnap.docs.map(d=>({id:d.id, ...d.data()}));

  const listSnap = await FS.getDocs(FS.query(FS.collection(db,"sales"), FS.orderBy("date","desc"), FS.limit(50)));
  const sales = listSnap.docs.map(d=>({id:d.id, ...d.data()}));

  routeContent.innerHTML = `
    ${tplHeader("Sales")}
    <div class="row g-3">
      <div class="col-12 col-lg-6">
        <div class="card p-3">
          <div class="fw-semibold mb-2">New Sale (Stock minus)</div>

          <div class="row g-2">
            <div class="col-12 col-md-6">
              <label class="form-label">Customer</label>
              <select class="form-select" id="sCustomer">
                <option value="">Walk-in</option>
                ${customers.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}
              </select>
            </div>
            <div class="col-12 col-md-6">
              <label class="form-label">Date</label>
              <input class="form-control" id="sDate" type="date" value="${fmtDate(new Date())}">
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label">Discount</label>
              <input class="form-control" id="sDisc" type="number" step="0.01" value="0">
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label">Paid</label>
              <input class="form-control" id="sPaid" type="number" step="0.01" value="0">
            </div>
            <div class="col-12 col-md-4">
              <label class="form-label">Net</label>
              <input class="form-control" id="sNet" type="text" readonly value="0">
            </div>
          </div>

          <hr class="my-3"/>

          <div class="d-flex align-items-center mb-2">
            <div class="fw-semibold">Items</div>
            <button class="btn btn-sm btn-outline-primary ms-auto" id="btnAddItem">+ Add Item</button>
          </div>

          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Medicine</th><th class="text-end">Qty</th><th class="text-end">Price</th><th class="text-end">Line</th><th></th></tr></thead>
              <tbody id="sItems"></tbody>
            </table>
          </div>

          <div class="d-flex align-items-center">
            <div class="fw-semibold">Total: <span id="sTotal">0</span></div>
            <button class="btn btn-primary ms-auto" id="btnSaveSale">Save Sale</button>
          </div>
          <div class="form-text mt-2">Stock deduction FEFO: پہلے expiry والا batch پہلے نکلے گا۔</div>
        </div>
      </div>

      <div class="col-12 col-lg-6">
        <div class="card p-3">
          <div class="fw-semibold mb-2">Recent Sales</div>
          <div class="table-responsive">
            <table class="table table-sm align-middle">
              <thead><tr><th>Date</th><th>ID</th><th class="text-end">Net</th></tr></thead>
              <tbody>
                ${sales.map(s=>`
                  <tr>
                    <td class="mono">${s.date}</td>
                    <td class="mono">${s.id}</td>
                    <td class="text-end fw-semibold">${money(s.net)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
            ${sales.length ? "" : tplEmpty("No sales yet")}
          </div>
        </div>
      </div>
    </div>
  `;

  const items = [];
  const renderItems = ()=>{
    const tbody = $("sItems");
    tbody.innerHTML = items.map((it, idx)=>{
      const med = meds.find(m=>m.id===it.medicineId);
      const price = (it.sellingPrice ?? med?.sellingPrice ?? 0);
      it.sellingPrice = Number(price||0);

      const line = Number(it.qty||0) * Number(it.sellingPrice||0);

      return `<tr>
        <td style="min-width:200px">
          <select class="form-select form-select-sm sMed" data-idx="${idx}">
            <option value="">Select</option>
            ${meds.map(m=>`<option value="${m.id}" ${m.id===it.medicineId?"selected":""}>${m.name}</option>`).join("")}
          </select>
        </td>
        <td><input class="form-control form-control-sm sQty text-end" data-idx="${idx}" type="number" step="1" value="${it.qty||0}"></td>
        <td><input class="form-control form-control-sm sPrice text-end" data-idx="${idx}" type="number" step="0.01" value="${it.sellingPrice||0}"></td>
        <td class="text-end fw-semibold">${money(line)}</td>
        <td class="text-end"><button class="btn btn-sm btn-outline-danger sDel" data-idx="${idx}">×</button></td>
      </tr>`;
    }).join("");

    tbody.querySelectorAll(".sMed").forEach(el=> el.onchange = ()=>{
      const idx = el.dataset.idx;
      items[idx].medicineId = el.value;
      const med = meds.find(m=>m.id===el.value);
      if(med) items[idx].sellingPrice = Number(med.sellingPrice||0);
      calc();
      renderItems();
    });
    tbody.querySelectorAll(".sQty").forEach(el=> el.oninput = ()=>{ items[el.dataset.idx].qty = Number(el.value||0); calc(); renderItems(); });
    tbody.querySelectorAll(".sPrice").forEach(el=> el.oninput = ()=>{ items[el.dataset.idx].sellingPrice = Number(el.value||0); calc(); renderItems(); });
    tbody.querySelectorAll(".sDel").forEach(el=> el.onclick = ()=>{ items.splice(el.dataset.idx,1); renderItems(); calc(); });

    calc();
  };

  const calc = ()=>{
    const total = items.reduce((a,it)=> a + Number(it.qty||0)*Number(it.sellingPrice||0), 0);
    const disc = Number($("sDisc").value||0);
    const net = Math.max(0, total - disc);
    $("sTotal").textContent = money(total);
    $("sNet").value = money(net);
  };

  $("sDisc").oninput = calc;

  $("btnAddItem").onclick = ()=>{
    items.push({ medicineId:"", qty:1, sellingPrice:0 });
    renderItems();
  };

  items.push({ medicineId:"", qty:1, sellingPrice:0 });
  renderItems();

  $("btnSaveSale").onclick = async ()=>{
    const date = parseDate($("sDate").value) || new Date();
    const customerId = $("sCustomer").value || "";
    const discount = Number($("sDisc").value||0);
    const paid = Number($("sPaid").value||0);

    const clean = items
      .filter(it=> it.medicineId && Number(it.qty||0)>0)
      .map(it=> ({ medicineId: it.medicineId, qty:Number(it.qty||0), sellingPrice:Number(it.sellingPrice||0) }));

    if(!clean.length) return notify("کم از کم 1 item ضروری ہے");

    try{
      await recordSale({ customerId, date, items: clean, discount, paid });
      notify("Sale saved");
      location.hash = "#/dashboard";
    } catch(e){
      console.error(e);
      notify(e.message || "Error");
    }
  };
}

async function routeReports(){
  const today = new Date();
  const fromDefault = new Date(today.getTime() - 7*24*3600*1000);

  routeContent.innerHTML = `
    ${tplHeader("Reports")}
    <div class="card p-3">
      <div class="row g-2 align-items-end">
        <div class="col-12 col-md-4">
          <label class="form-label">From</label>
          <input class="form-control" id="rFrom" type="date" value="${fmtDate(fromDefault)}">
        </div>
        <div class="col-12 col-md-4">
          <label class="form-label">To</label>
          <input class="form-control" id="rTo" type="date" value="${fmtDate(today)}">
        </div>
        <div class="col-12 col-md-4 d-flex gap-2">
          <button class="btn btn-primary flex-grow-1" id="btnRun">Run</button>
          <button class="btn btn-outline-secondary" id="btnExport">Export CSV</button>
        </div>
      </div>

      <hr class="my-3"/>

      <div class="row g-3" id="rSummary"></div>

      <div class="row g-3 mt-1">
        <div class="col-12 col-lg-6">
          <div class="card p-3">
            <div class="fw-semibold mb-2">Sales</div>
            <div class="table-responsive">
              <table class="table table-sm align-middle">
                <thead><tr><th>Date</th><th>ID</th><th class="text-end">Net</th></tr></thead>
                <tbody id="rSales"></tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="col-12 col-lg-6">
          <div class="card p-3">
            <div class="fw-semibold mb-2">Purchases</div>
            <div class="table-responsive">
              <table class="table table-sm align-middle">
                <thead><tr><th>Date</th><th>Invoice</th><th class="text-end">Total</th></tr></thead>
                <tbody id="rPurch"></tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  let lastData = { sales:[], purchases:[] };

  const run = async ()=>{
    const from = $("rFrom").value;
    const to = $("rTo").value;

    const salesSnap = await FS.getDocs(FS.query(
      FS.collection(db,"sales"),
      FS.where("date", ">=", from),
      FS.where("date", "<=", to),
      FS.orderBy("date","desc"),
      FS.limit(500)
    ));

    const purchSnap = await FS.getDocs(FS.query(
      FS.collection(db,"purchases"),
      FS.where("date", ">=", from),
      FS.where("date", "<=", to),
      FS.orderBy("date","desc"),
      FS.limit(500)
    ));

    const sales = salesSnap.docs.map(d=>({id:d.id, ...d.data()}));
    const purchases = purchSnap.docs.map(d=>({id:d.id, ...d.data()}));
    lastData = { sales, purchases };

    const salesTotal = sales.reduce((a,s)=>a + Number(s.net||0),0);
    const salesCount = sales.length;
    const purchTotal = purchases.reduce((a,p)=>a + Number(p.total||0),0);
    const purchCount = purchases.length;

    $("rSummary").innerHTML = `
      ${cardRow("Sales Total", money(salesTotal))}
      ${cardRow("Sales Count", `${salesCount}`)}
      ${cardRow("Purchases Total", money(purchTotal))}
      ${cardRow("Purchases Count", `${purchCount}`)}
    `;

    $("rSales").innerHTML = sales.map(s=>`
      <tr>
        <td class="mono">${s.date}</td>
        <td class="mono">${s.id}</td>
        <td class="text-end fw-semibold">${money(s.net)}</td>
      </tr>`).join("") || `<tr><td colspan="3">${tplEmpty("No sales")}</td></tr>`;

    $("rPurch").innerHTML = purchases.map(p=>`
      <tr>
        <td class="mono">${p.date}</td>
        <td>${p.invoiceNo||""}</td>
        <td class="text-end fw-semibold">${money(p.total)}</td>
      </tr>`).join("") || `<tr><td colspan="3">${tplEmpty("No purchases")}</td></tr>`;
  };

  $("btnRun").onclick = run;
  $("btnExport").onclick = ()=>{
    const rows = [["type","date","id_or_invoice","total_or_net"]];
    lastData.sales.forEach(s=> rows.push(["sale", s.date, s.id, s.net||0]));
    lastData.purchases.forEach(p=> rows.push(["purchase", p.date, p.invoiceNo||p.id, p.total||0]));
    downloadCSV("report.csv", rows);
  };

  run();
}

async function routeSettings(){
  const settings = await getSettings();

  routeContent.innerHTML = `
    ${tplHeader("Settings")}
    <div class="card p-3">
      <div class="row g-2">
        <div class="col-12 col-md-6">
          <label class="form-label">Store Name</label>
          <input class="form-control" id="stName" value="${settings?.storeName||""}">
        </div>
        <div class="col-12 col-md-6">
          <label class="form-label">Phone</label>
          <input class="form-control" id="stPhone" value="${settings?.phone||""}">
        </div>
        <div class="col-12">
          <label class="form-label">Address</label>
          <input class="form-control" id="stAddr" value="${settings?.address||""}">
        </div>
        <div class="col-12 col-md-4">
          <label class="form-label">Currency</label>
          <input class="form-control" id="stCur" value="${settings?.currency||"PKR"}">
        </div>
        <div class="col-12 col-md-4">
          <label class="form-label">Expiry Alert Days</label>
          <input class="form-control" id="stExp" type="number" step="1" value="${settings?.expiryAlertDays ?? 30}">
        </div>
        <div class="col-12 col-md-4">
          <label class="form-label">Default Low Stock Level</label>
          <input class="form-control" id="stLow" type="number" step="1" value="${settings?.lowStockDefault ?? 10}">
        </div>
      </div>

      <div class="d-flex gap-2 mt-3">
        <button class="btn btn-primary" id="btnSave">Save</button>
        <button class="btn btn-outline-secondary" id="btnExportAll">Export All Data (JSON)</button>
      </div>

      <hr class="my-3"/>

      <div class="alert alert-info mb-0">
        <div class="fw-semibold">Backup Tip</div>
        Export All Data سے JSON backup بنائیں۔ (Restore feature next version میں)
      </div>
    </div>
  `;

  $("btnSave").onclick = async ()=>{
    const ref = FS.doc(db, "settings", "main");
    await FS.setDoc(ref, {
      storeName: $("stName").value.trim(),
      phone: $("stPhone").value.trim(),
      address: $("stAddr").value.trim(),
      currency: $("stCur").value.trim() || "PKR",
      expiryAlertDays: Number($("stExp").value||30),
      lowStockDefault: Number($("stLow").value||10),
      updatedAt: FS.serverTimestamp()
    }, { merge:true });
    notify("Saved");
    routeSettings();
  };

  $("btnExportAll").onclick = async ()=>{
    const cols = ["medicines","batches","customers","suppliers","sales","purchases","settings"];
    const data = {};
    for(const c of cols){
      const snap = await FS.getDocs(FS.query(FS.collection(db,c), FS.limit(5000)));
      data[c] = snap.docs.map(d=>({id:d.id, ...d.data()}));
    }
    const blob = new Blob([JSON.stringify(data,null,2)], { type:"application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `medical-store-backup-${fmtDate(new Date())}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
}

function downloadCSV(filename, rows){
  const csv = rows.map(r => r.map(v=>{
    const s = String(v ?? "");
    if(s.includes('"') || s.includes(",") || s.includes("\n")){
      return `"${s.replace(/"/g,'""')}"`;
    }
    return s;
  }).join(",")).join("\n");

  const blob = new Blob([csv], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Router ----------
async function renderRoute(){
  setActiveNav();
  const hash = location.hash || "#/dashboard";
  const path = hash.replace("#","");

  const routes = {
    "/dashboard": routeDashboard,
    "/inventory": routeInventory,
    "/purchases": routePurchases,
    "/sales": routeSales,
    "/customers": routeCustomers,
    "/suppliers": routeSuppliers,
    "/reports": routeReports,
    "/settings": routeSettings
  };

  const fn = routes[path] || routeDashboard;
  await fn();
}

function showAuth(){
  $("view-auth").classList.remove("d-none");
  $("view-app").classList.add("d-none");
}
function showApp(){
  $("view-auth").classList.add("d-none");
  $("view-app").classList.remove("d-none");
}

// ---------- Boot ----------
function bindAuthButtons(){
  $("btnLogin").onclick = async ()=>{
    const email = $("loginEmail").value.trim();
    const pass = $("loginPass").value;
    try{
      await Auth.login(email, pass);
      notify("Logged in");
    } catch(e){
      console.error(e);
      notify(e.message || "Login failed");
    }
  };

  $("btnRegister").onclick = async ()=>{
    const email = $("loginEmail").value.trim();
    const pass = $("loginPass").value;
    try{
      await Auth.register(email, pass);
      notify("Registered & logged in");
    } catch(e){
      console.error(e);
      notify(e.message || "Register failed");
    }
  };

  $("btnLogout").onclick = async ()=>{ await Auth.logout(); };
  $("btnLogoutMobile").onclick = async ()=>{ await Auth.logout(); };
}

bindAuthButtons();

Auth.onChange(async (user)=>{
  const badge = $("userBadge");
  const badgeM = $("userBadgeMobile");

  if(user){
    badge.textContent = user.email;
    badgeM.textContent = user.email;
    showApp();
    await ensureSettings(user.uid);
    if(!location.hash) location.hash = "#/dashboard";
    await renderRoute();
  } else {
    badge.textContent = "Offline";
    badgeM.textContent = "Offline";
    showAuth();
  }
});

window.addEventListener("hashchange", ()=>{
  renderRoute();
});

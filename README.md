# Medical Store Manager (Firebase + GitHub + Hosting)

یہ ایک سادہ لیکن مکمل **Medical Store / Pharmacy** ویب سافٹ ویئر ہے جو:
- Inventory (Medicines)  
- Stock (Batch/Expiry کے ساتھ)  
- Purchase (Stock add)  
- Sale (Stock minus, FEFO یعنی پہلے expiry والا stock پہلے نکلے گا)  
- Expiry Alerts (مثلاً اگلے 30 دن)  
- Low Stock Alerts (Reorder level)  
- Customers / Suppliers  
- Reports (Today / Date range Sales & Purchases)  
- Export (CSV)  
- Login (Firebase Auth)

> یہ ویب ایپ ہے، موبائل میں بھی اچھا چلتی ہے (Responsive)۔  
> آپ اسے Firebase Hosting پر Live کر کے Chrome میں “Add to Home Screen” کر کے موبائل پر بھی استعمال کر سکتے ہیں۔

---

## 1) فائلیں کہاں ہیں؟
یہ پورا پروجیکٹ `medical-store-webapp` فولڈر میں ہے۔

اہم فائلیں:
- `index.html` (UI)
- `assets/app.js` (Main logic)
- `assets/firebase.js` (Firebase init + helpers)
- `assets/config.js` (**یہاں آپ اپنا firebaseConfig لگائیں گے**)
- `firebase.json` (Hosting config)
- `firestore.rules` (Basic rules)

---

## 2) Firebase پر Setup (Step by Step)

### A) Firebase Project بنائیں
1. Firebase Console کھولیں
2. **Create project**
3. Project بننے کے بعد: **Build → Authentication → Get started**
4. **Sign-in method → Email/Password Enable**

### B) Firestore Database بنائیں
1. **Build → Firestore Database → Create database**
2. Start in **test mode** (ابھی) یا rules فائل بعد میں لگا دیں

### C) Web App Register کریں
1. Project settings (⚙) → **Your apps** → Web `</>`
2. App nickname: `medical-store`
3. Register
4. آپ کو `firebaseConfig` ملے گا

### D) firebaseConfig لگائیں
`assets/config.js` کھولیں اور اپنی values paste کریں:
```js
export const firebaseConfig = {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "..."
};
```

---

## 3) GitHub پر Upload (آسان طریقہ)

### طریقہ 1: GitHub Desktop (سب سے آسان)
1. GitHub Desktop install
2. File → Add local repository → اس فولڈر کو select کریں
3. Publish repository (Public/Private آپ کی مرضی)

### طریقہ 2: Manual Upload (زیادہ آسان)
1. GitHub پر نیا repo بنائیں
2. Repo میں **Upload files** → اس فولڈر کی تمام فائلیں upload کر دیں

---

## 4) Firebase Hosting پر Live کرنا (Step by Step)

### A) Node.js install
Node.js LTS install کریں (اگر پہلے سے ہے تو OK)

### B) Firebase CLI install
CMD/Terminal کھولیں:
```bash
npm install -g firebase-tools
firebase login
```

### C) Project init
اسی فولڈر میں terminal کھولیں جہاں `index.html` ہے:
```bash
firebase init
```

Options:
- ✅ Hosting
- ✅ Firestore (optional اگر آپ rules deploy کرنا چاہتے ہیں)
- Select existing project → اپنا project select
- Public directory: `.`   (dot)
- Single-page app: `Yes`
- Overwrite index.html? `No`

### D) Deploy
```bash
firebase deploy
```

Deploy کے بعد Hosting URL آئے گا، اسی کو Chrome میں کھولیں۔

---

## 5) Default Data Structure (آپ کے لئے)
Collections:
- `medicines`
- `batches`
- `customers`
- `suppliers`
- `sales`
- `purchases`
- `settings` (single doc: `main`)

---

## 6) Firestore Rules (Basic)
`firestore.rules` میں basic rules ہیں:
- صرف logged-in user کو access

Deploy (اگر init میں Firestore لیا تھا):
```bash
firebase deploy --only firestore:rules
```

---

## 7) Notes
- Multi-user business کیلئے بہتر rules / roles چاہیے ہوں تو بتا دیں (Admin/Staff)
- Invoice/Receipt پر logo اور print format بھی add کیا جا سکتا ہے

---

اگر آپ چاہیں تو میں آپ کیلئے:
- Urdu invoice print design
- Barcode field + scanning
- Profit report (FIFO/FEFO cost)
- Multi-branch
بھی add کر دوں۔

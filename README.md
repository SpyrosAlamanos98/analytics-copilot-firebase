# Circana KPIs Analysis — Firebase edition (Spark / no-cost build)

100% client-side rewrite of the original Streamlit app. No Cloud Functions,
no Cloud Storage — everything runs in the browser, so the whole project
stays on Firebase's **free Spark plan** (no billing account needed).

| Πριν (Streamlit)              | Τώρα (Firebase, Spark)                    |
|---------------------------------|---------------------------------------------|
| `auth.py` + SQLite               | Firebase Authentication (Email/Password)    |
| `storage.py` + local `data/`     | Firestore — parsed report rows, chunked into documents |
| Streamlit UI (`st.*`)            | Static HTML/CSS/JS on Firebase Hosting, Chart.js for charts |
| pandas parsing (`clean_circana_report`) | Same logic, ported to JS in `public/js/report-engine.js`, using SheetJS (xlsx) + PapaParse (csv) to read files in-browser |
| Gemini calls via `google-genai` (server) | Direct `fetch()` calls to the Gemini REST API **from the browser** |
| `.env` global Gemini key         | Key stored per-user in Firestore (same as the Blaze build) |

## The trade-off you accepted by going Spark-only

Because there's no backend, the **Gemini API key is visible in the
browser's Network tab** while a request is in flight (and stored, as
plaintext, in the user's own Firestore document). This is fine for an
internal tool used by trusted @circana.com colleagues. It would **not** be
appropriate if this app were ever opened up to untrusted or external users
— at that point, bring back the Cloud Functions layer from the Blaze build
so the key never reaches the client.

The signup domain lock (`@circana.com` only) is also softer than the Blaze
build: without a Cloud Functions blocking trigger, someone could technically
*create* an Auth account with any email. But every Firestore read/write in
the app is gated by `firestore.rules` on that same domain check, so a
non-circana account authenticates successfully but can't actually do
anything — functionally locked out, just not blocked at signup.

## Δομή

```
analytics-copilot/
├── firebase.json           # hosting + firestore only — no functions/storage
├── .firebaserc               # βάλε εδώ το project id σου
├── firestore.rules
└── public/
    ├── index.html
    ├── css/style.css
    └── js/
        ├── firebase-config.js   # βάλε εδώ το SDK config σου
        ├── file-parser.js        # SheetJS/PapaParse → array-of-arrays
        ├── report-engine.js      # parser + QC checks + local chat engine (JS port of report_engine.py)
        ├── firestore-storage.js  # save/load/delete parsed reports, chunked
        ├── gemini.js              # client-side Gemini REST calls
        └── app.js                 # UI wiring
```

## Βήματα εγκατάστασης

### 1. Δημιούργησε Firebase project (Spark plan — δωρεάν, καμία κάρτα)
[console.firebase.google.com](https://console.firebase.google.com) → Add project.
**Μην** κάνεις upgrade σε Blaze — δεν χρειάζεται τίποτα εδώ.

### 2. Ενεργοποίησε τα services
- **Authentication** → Sign-in method → ενεργοποίησε **Email/Password**
- **Firestore Database** → Create database (production mode)

### 3. Βάλε το project config στον κώδικα
- `.firebaserc`: αντικατέστησε `REPLACE-WITH-YOUR-FIREBASE-PROJECT-ID`
- `public/js/firebase-config.js`: αντικατέστησε τα `REPLACE_ME` με τα στοιχεία από
  Project settings → General → "Your apps" → Web app → SDK config

### 4. Εγκατάσταση εργαλείων
```bash
npm install -g firebase-tools
firebase login
```

### 5. Deploy
```bash
cd analytics-copilot
firebase deploy --only firestore:rules,hosting
```
Αυτό είναι όλο — δεν υπάρχει functions deploy, άρα δεν χρειάζεται να ενεργοποιήσεις
Cloud Build/Artifact Registry APIs.

## Πώς λειτουργεί κάθε κομμάτι

- **Upload**: το `file-parser.js` διαβάζει το .xlsx/.csv απευθείας στον browser
  (SheetJS/PapaParse). Το `report-engine.js` τρέχει τον ίδιο parser/QC κώδικα
  με πριν, απλά σε JavaScript. Το αποτέλεσμα αποθηκεύεται στο Firestore
  (`firestore-storage.js`), σε chunks των 500 γραμμών ώστε να μη ξεπερνάει
  κανένα document το όριο του 1 MiB.
- **Ανάλυση**: πατώντας "Ανάλυση", φορτώνονται τα chunks των επιλεγμένων
  reports από Firestore, ενώνονται, και τρέχει QC + trend + movers — όλα
  τοπικά στον browser, χωρίς round-trip σε server.
- **Chat**: είτε το δωρεάν keyword-engine (τοπικό JS), είτε Gemini αν έχεις
  αποθηκεύσει key — και στις δύο περιπτώσεις τρέχει στον browser.
- **Exec summary**: πάντα Gemini, client-side call.

## Γνωστοί περιορισμοί έναντι του Blaze build

- Το Gemini key είναι ορατό client-side (βλ. πάνω) — αποδεκτό μόνο για
  trusted, εσωτερική χρήση.
- Πολύ μεγάλα reports (πολλές δεκάδες χιλιάδες γραμμές) θα δημιουργήσουν
  πολλά chunk documents — ακόμα μέσα στα δωρεάν όρια του Firestore
  (50k reads/20k writes/ημέρα), αλλά κάπως πιο αργό στο load από ένα raw
  αρχείο σε Storage.
- Χωρίς rate limiting στο login/register — πρόσθεσε
  [Firebase App Check](https://firebase.google.com/docs/app-check) αν θες
  προστασία από bots (δουλεύει και στο Spark plan).
- Το Gemini model name (`gemini-3.6-flash`) είναι ίδιο με το αρχικό script —
  αν το Google API αλλάξει naming, ενημέρωσε το `public/js/gemini.js`.

## Αν αργότερα χρειαστείς την Blaze/Cloud Functions εκδοχή

Κράτησέ τη διαθέσιμη — αν κάποτε ανοίξεις το app σε μη-trusted χρήστες, ή
μεγαλώσουν πολύ τα reports, η αρχιτεκτονική με Cloud Functions (server-side
parsing, key ποτέ στον client) είναι το επόμενο λογικό βήμα.

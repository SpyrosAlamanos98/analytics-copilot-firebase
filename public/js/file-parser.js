// file-parser.js
// Turns an uploaded File (xlsx or csv) into one or more "sheets", each a raw
// array-of-arrays of cell values — matching what pandas.read_excel(header=None)
// gave the original app, but per-sheet instead of just the first one.
// Relies on the SheetJS and PapaParse globals loaded via CDN in index.html.

// Returns: [{ sheetName: string|null, rows: any[][] }, ...]
// CSV files have no concept of sheets, so they come back as a single-item
// array with sheetName: null.
export function readFileAsSheets(file) {
  const isCsv = /\.csv$/i.test(file.name);
  if (isCsv) return readCsvAsSheets(file);
  return readXlsxAllSheets(file);
}

async function readCsvAsSheets(file) {
  const rows = await readCsv(file);
  return [{ sheetName: null, rows }];
}

function readCsv(file) {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line no-undef
    Papa.parse(file, {
      complete: (results) => resolve(results.data),
      error: reject,
      skipEmptyLines: false,
    });
  });
}

function readXlsxAllSheets(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // eslint-disable-next-line no-undef
        const wb = XLSX.read(e.target.result, { type: "array" });
        const sheets = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          // eslint-disable-next-line no-undef
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
          return { sheetName: name, rows };
        });
        resolve(sheets);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
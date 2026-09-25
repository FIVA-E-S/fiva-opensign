const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

async function main() {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const externalStyles = html.match(/<link\b[^>]*href="https:[^>]*>/g) || [];
  assert.ok(externalStyles.length > 0);
  for (const link of externalStyles) {
    assert.match(link, /media="print"/);
    assert.match(link, /onload="this\.media='all'"/);
  }
  const utils = fs.readFileSync(path.join(root, "src/constant/Utils.js"), "utf8");
  assert.ok(!utils.includes("cdn.opensignlabs.com/webfonts"));
  assert.equal(utils.match(/fileasbytes\(documentFontUrl\)/g).length, 2);
  const bytes = fs.readFileSync(path.join(root, "src/assets/fonts/times.ttf"));
  assert.deepEqual(bytes, fs.readFileSync(path.join(root, "../OpenSignServer/font/times.ttf")));
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(bytes, { subset: true });
  const page = pdf.addPage();
  page.drawText("OpenSign™ DocumentId: test - España, autorización, 10€", { font, size: 12 });
  const saved = await pdf.save();
  assert.equal((await PDFDocument.load(saved)).getPageCount(), 1);
  console.log("PASS: nonblocking external CSS; both PDF paths use the bundled font; accented PDF text renders.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });

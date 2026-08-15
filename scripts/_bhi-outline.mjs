import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'node:fs';
const path = '/root/testfiles/A Brief History of Intelligence (Max Bennett) (z-library.sk, 1lib.sk, z-lib.sk).pdf';
const data = new Uint8Array(fs.readFileSync(path));
const doc = await getDocument({ data, useSystemFonts: true }).promise;
console.log('num pages', doc.numPages);
const outline = await doc.getOutline();
const walk = (items, depth=0) => { for (const it of items || []) { console.log('  '.repeat(depth) + '• ' + JSON.stringify(it.title)); if (it.items?.length) walk(it.items, depth+1); } };
if (!outline) console.log('NO OUTLINE'); else walk(outline);

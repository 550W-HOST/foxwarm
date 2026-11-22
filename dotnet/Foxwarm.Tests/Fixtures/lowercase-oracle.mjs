// Platform String.prototype.toLowerCase oracle for SourceStringLower: no application code is
// loaded. Writes every Unicode scalar plus contextual-sigma cases and their lowercase form.
// Usage: node lowercase-oracle.mjs OUTPUT_DIRECTORY
import fs from 'node:fs/promises'
import path from 'node:path'

if (process.versions.unicode !== '17.0') {
  throw new Error(`Unicode 17.0 is required for the lowercase comparison; use Node 24.21.0 (running Node ${process.versions.node}, Unicode ${process.versions.unicode}).`);
}
const [root] = process.argv.slice(2)
if (!root) throw new Error('usage: lowercase-oracle.mjs OUTPUT_DIRECTORY')
// Exercise full, locale-independent lowercasing, including contextual sigma.
let text = 'İ ΟΣ ΟΣΑ ΟΣ\u0307Α ΟΣ\u2019 ΑΣ꟎ ꟎Σ ΑΣ\u{16EA0} \u{16EA0}Σ ΑΣ\u1ACFΑ Α\u1ACFΣ '; for (let code = 0; code <= 0x10ffff; code++) if (code < 0xd800 || code > 0xdfff) text += String.fromCodePoint(code)
await fs.writeFile(path.join(root, 'lower-input.txt'), text); await fs.writeFile(path.join(root, 'lower-expected.txt'), text.toLowerCase())

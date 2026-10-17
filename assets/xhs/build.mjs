import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
const root = dirname(fileURLToPath(import.meta.url));
for (let i=1;i<=5;i++) {
  const name=String(i).padStart(2,'0');
  execFileSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless','--no-sandbox','--disable-gpu','--hide-scrollbars','--no-pdf-header-footer','--force-device-scale-factor=1','--window-size=1080,1440',`--user-data-dir=${mkdtempSync(join(tmpdir(),'modeck-xhs-'))}`,`--screenshot=${join(root,name+'.png')}`,`file://${join(root,name+'.html')}`],{stdio:'ignore',timeout:30000});
  console.log(`${name}.png built`);
}

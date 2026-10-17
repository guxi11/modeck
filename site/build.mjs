import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const output = process.argv[2] ? resolve(process.argv[2]) : join(source, 'dist');
if (output === source || output === dirname(source)) {
  throw new Error('Build output must be a separate directory.');
}

await mkdir(join(output, 'assets'), { recursive: true });
for (const filename of ['index.html', 'styles.css', 'main.js']) {
  await cp(join(source, filename), join(output, filename));
}
for (const filename of ['logo.svg', 'icon.svg']) {
  await cp(join(source, '..', 'assets', filename), join(output, 'assets', filename));
}
try {
  await stat(join(source, 'assets'));
  await cp(join(source, 'assets'), join(output, 'assets'), { recursive: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const html = await readFile(join(output, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)=["'](\.\/?[^"'#?]+)["']/g)) {
  await stat(resolve(output, match[1]));
}
await writeFile(join(output, '.nojekyll'), '');
console.log(`Built modeck product site: ${output}`);

import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/ui', {recursive:true});
for (const name of ['index.html','style.css','quick.html','quick.css','capture-worklet.js','icon.png','icon.ico']) await copyFile(`src/ui/${name}`, `dist/ui/${name}`);
await copyFile('src/preload.cjs','dist/preload.cjs');
await copyFile('src/quick-preload.cjs','dist/quick-preload.cjs');

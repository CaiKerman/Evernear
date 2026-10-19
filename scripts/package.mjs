import fs from 'node:fs/promises';
import path from 'node:path';
import { packager } from '@electron/packager';
const platform=process.argv[2] || 'win32';
const result=await packager({dir:'.', name:'AmbientCompanion', platform, arch:'x64', out:'release', overwrite:true,
  asar:true, prune:true, executableName:'VoiceAssistant',icon:platform==='win32'?'src/ui/icon.ico':'src/ui/icon.png',electronLanguages:['zh-CN','en-US'],
  ignore:[/^\/src($|\/)/,/^\/scripts($|\/)/,/^\/personal($|\/)/,/^\/release($|\/)/,/^\/docs($|\/)/,/^\/tsconfig.json$/,/^\/dist\/tests($|\/)/],
  win32metadata:{CompanyName:'Personal Software',FileDescription:'Ambient Companion — Personal voice assistant',ProductName:'Ambient Companion'}});
for(const dir of result)for(const name of await fs.readdir(dir))if(/^\.VoiceAssistant\.exe\.[A-Za-z0-9]+$/.test(name))await fs.unlink(path.join(dir,name));
console.log(result.join('\n'));

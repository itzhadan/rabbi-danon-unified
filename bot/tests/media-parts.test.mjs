import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
const execFile = promisify(execFileCallback);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
try {
  const fixture = path.join(temp, 'fixture.mp4');
  await execFile('ffmpeg', ['-v','error','-y','-f','lavfi','-i','testsrc2=size=320x240:rate=25','-t','6','-c:v','mpeg4','-q:v','2','-g','50',fixture]);
  const source = fs.readFileSync(new URL('../bot.mjs', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('const MEDIA_LIMIT'), source.indexOf('// ---------- WhatsApp ----------')).replaceAll('95_000_000','95_000').replaceAll('75_000_000','75_000');
  const moduleSource = `import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFile} from 'node:child_process';\n${helper}`;
  const { splitMedia } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));
  const input = fs.readFileSync(fixture);
  const parts = await splitMedia(input, true);
  assert(parts.length > 1);
  assert(parts.every(part => part.length > 0 && part.length <= 95_000));
  let duration = 0;
  for (let i=0; i<parts.length; i++) {
    const file=path.join(temp, `part-${i}.mp4`); fs.writeFileSync(file, parts[i]);
    const {stdout}=await execFile('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file]);
    assert(Number(stdout) > 0); duration += Number(stdout);
  }
  assert(Math.abs(duration-6)<0.05, 'The complete source duration must be preserved');
  assert.equal((await splitMedia(Buffer.from('small'), true)).length, 1);
  console.log(`PASS: ${parts.length} playable parts, size limit, full duration, small-file passthrough`);
} finally { fs.rmSync(temp, {recursive:true,force:true}); }

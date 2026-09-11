import fs from 'node:fs';
const video=fs.readFileSync('tools/fixtures/media-before.mp4');
const padding=Buffer.alloc(8*1024*1024-video.length);
padding.writeUInt32BE(padding.length);padding.write('free',4);
fs.mkdirSync('output/playwright',{recursive:true});
fs.writeFileSync('output/playwright/media-large.mp4',Buffer.concat([video,padding]));

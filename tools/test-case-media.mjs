import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const media=require('../assets/js/case-media.js');
const layouts=require('../assets/js/case-photo-layouts.js');
const before=fs.readFileSync(new URL('fixtures/media-before.mp4',import.meta.url));
const after=fs.readFileSync(new URL('fixtures/media-after.mp4',import.meta.url));
const inspect=buffer=>media.inspectMp4(async (a,b)=>buffer.subarray(a,b),buffer.length);
const meta=await inspect(before);
assert.equal(meta.duration,4);assert.equal(meta.videoCodec,'h264');assert.equal(meta.audioCodec,'aac');
assert.equal((await inspect(after)).audioCodec,null);
let requested=0;
await media.inspectMp4(async(a,b)=>{requested+=b-a;return before.subarray(a,b);},before.length);
assert.ok(requested<before.length/4,'validation reads headers, not the video payload');
await assert.rejects(()=>media.inspectMp4(()=>{throw Error('must not read');},media.MAX_BYTES+1),/50MB/);
await assert.rejects(()=>inspect(Buffer.from('not a movie')),/MP4/);
const hevc=Buffer.from(before);hevc.write('hvc1',hevc.lastIndexOf('avc1'));
await assert.rejects(()=>inspect(hevc),/H.264/);
const tooLong=Buffer.from(before), mvhd=tooLong.indexOf('mvhd')+4;
tooLong.writeUInt32BE(tooLong.readUInt32BE(mvhd+12)*61,mvhd+16);
await assert.rejects(()=>inspect(tooLong),/60 秒/);
const invalid=Buffer.from(before);invalid.writeUInt32BE(0xffffffff,0);
await assert.rejects(()=>inspect(invalid),/MP4/);

const combos=[['single','image'],['single','video'],['comparison','image','image'],['comparison','image','video'],['comparison','video','image'],['comparison','video','video']];
const rows=[];
for(const [layoutKind,left,right] of combos){
 const group={layout_kind:layoutKind,before_media_type:left,after_media_type:right||'image',before_private_path:'before',after_private_path:right?'after':null};
 for(const side of media.sides(group))if(group[`${side}_media_type`]==='video'){group[`${side}_video_meta`]=meta;group[`${side}_poster_private_path`]='poster';}
 assert.equal(media.validateDraft(group),true);
 const publicGroup={layoutKind,before:{type:left,src:'before',poster:'poster'},after:right?{type:right,src:'after',poster:'poster'}:null};
 assert.equal(media.complete(publicGroup),true);
 if(right)assert.equal(media.complete({...publicGroup,after:null}),false);
 for(const ratio of ['4:3','3:4','1:1'])for(const direction of ['horizontal','vertical']){
  const geometry=layouts.getLayout(ratio,direction,layoutKind);
  if(layoutKind==='single'){assert.equal(geometry.slotWidth,geometry.canvasWidth);assert.equal(geometry.slotHeight,geometry.canvasHeight);}
 }
 rows.push({...group,id:`group-${rows.length}`,published_layout_kind:layoutKind,published_before_media_type:left,published_after_media_type:right||null,before_public_path:'before',after_public_path:right?'after':null,before_poster_public_path:left==='video'?'poster':null,after_poster_public_path:right==='video'?'poster':null,published_before_video_meta:left==='video'?meta:null,published_after_video_meta:right==='video'?meta:null});
}
assert.throws(()=>media.validateDraft({layout_kind:'comparison',before_private_path:'before'}),/完整/);
assert.throws(()=>media.validateDraft({layout_kind:'single',before_private_path:'before',after_private_path:'hidden'}),/單一素材/);
assert.equal(media.complete({layoutKind:'single',before:{type:'video',src:'a'}}),false);
assert.equal(media.complete({before:{src:'before'},after:{src:'after'}}),true,'legacy local photo data');

let columns='';
const query={select(value){columns=value;return this;},eq(){return this;},order(){return this;},then(resolve){return Promise.resolve({data:[{id:'demo',case_photo_pairs:rows,case_treatments:[]}],error:null}).then(resolve);}};
const context={window:{SUPABASE_CONFIG:{url:'https://example.test',publishableKey:'test'},CasePhotoLayouts:layouts,supabase:{createClient:()=>({from:()=>query,storage:{from:bucket=>({getPublicUrl:path=>({data:{publicUrl:`${bucket}/${path}`}})})}})}}};
vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../assets/js/supabase-cases.js',import.meta.url),'utf8'),context);
const result=await context.window.CaseRepository.loadPublishedCases();
assert.equal(result.cases[0].mediaGroups.length,6);
assert.equal(result.cases[0].mediaGroups[1].before.src,'case-video-published/before');
assert.equal(result.cases[0].mediaGroups[0].before.src,'case-published/before');
assert.doesNotMatch(columns,/private_path|source_private|crop_rect/);
assert.match(columns,/published_layout_kind/);
console.log('Verified six media combinations, actual H.264/AAC MP4 headers, upload limits, legacy mapping and public field isolation.');

const uploaderContext={window:{CaseMedia:media}};
vm.createContext(uploaderContext);vm.runInContext(fs.readFileSync(new URL('../admin/media-upload.js',import.meta.url),'utf8'),uploaderContext);
const detect=uploaderContext.window.CaseMediaUpload.fileType;
for(const [name,type,expected] of [['photo.JPG','image/jpeg','image'],['photo.png','image/png','image'],['photo.webp','image/webp','image'],['movie.MP4','video/mp4','video'],['movie.mp4','','video']])assert.equal(detect({name,type}),expected);
for(const [name,type] of [['movie.mov','video/quicktime'],['movie.webm','video/webm'],['movie.mp4','text/html'],['photo.svg','image/svg+xml']])assert.throws(()=>detect({name,type}),/JPEG/);

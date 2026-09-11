import { copyGroup, publishedAssets, clearSnapshot, validateAssets, type Group } from "./case-media-workflow.ts";
import { handleCaseWorkflow } from "../case-workflow/index.ts";
function assert(value: unknown, message="Assertion failed"): asserts value {if(!value)throw new Error(message);}

Deno.test("all six media combinations copy to the correct bucket and snapshot",async()=>{
  for(const [kind,before,after] of [["single","image",null],["single","video",null],["comparison","image","image"],["comparison","image","video"],["comparison","video","image"],["comparison","video","video"]]){
    const calls: any[]=[];
    const client:any={storage:{from:(bucket:string)=>({copy:async(source:string,path:string,options:any)=>{calls.push({bucket,source,path,...options});return {error:null};}})}};
    const group:Group={id:"group",layout_kind:kind,canvas_ratio:"3:4",split_direction:"vertical",before_media_type:before,after_media_type:after};
    for(const side of ["before","after"]){group[`${side}_private_path`]=side;group[`${side}_poster_private_path`]=`${side}-poster`;group[`${side}_video_meta`]={duration:2};}
    const copied:any[]=[];const result=await copyGroup(client,"case",group,copied);
    assert(result.published_layout_kind===kind);
    assert(Boolean(result.after_public_path)===(kind==="comparison"));
    for(const call of calls)assert(call.destinationBucket===(call.bucket==="case-drafts"?"case-published":"case-video-published"));
    assert(copied.length===(before==="video"?2:1)+(after?(after==="video"?2:1):0));
    assert(publishedAssets([result]).length===copied.length);
    assert(Object.values(clearSnapshot()).every(value=>value===null));
  }
});

function setup({failCopy=0,failAudit=false,failPublish=false,reviewer=true,incomplete=false}={}) {
  const original:Group={id:"case",title:"測試案例",status:"pending_review",created_by:"owner",consent_confirmed:true,consent_confirmed_by:"owner",consent_confirmed_at:"date",published_at:null,case_treatments:[{treatment_id:"t"}],case_photo_pairs:[{id:"group",layout_kind:"comparison",canvas_ratio:"4:3",split_direction:"horizontal",before_private_path:"owner/case/b.webp",after_private_path:incomplete?null:"owner/case/a.webp",before_media_type:"image",after_media_type:"image",...clearSnapshot()}]};
  const state=structuredClone(original),log:any[]=[],copied:string[]=[],removed:string[]=[];let copyCount=0;
  const client:any={
    from:(table:string)=>({
      select:()=>({eq:()=>({maybeSingle:async()=>({data:structuredClone(state),error:null})})}),
      update:(values:Group)=>({eq:async()=>{
        log.push({table,values});
        if(table==="cases"&&values.status==="published"&&failPublish)return {error:{message:"case update failed"}};
        Object.assign(table==="cases"?state:state.case_photo_pairs[0],values);return {error:null};
      }})
    }),
    storage:{from:(bucket:string)=>({
      list:async(_prefix:string,{search}:{search:string})=>({data:[{name:search,metadata:{mimetype:"image/webp",size:100}}],error:null}),
      copy:async(_source:string,path:string)=>{copyCount++;if(copyCount===failCopy)return {error:{message:"copy failed"}};copied.push(path);return {error:null};},
      remove:async(paths:string[])=>{log.push({remove:paths,bucket});removed.push(...paths);return {error:null};}
    })}
  };
  const prepare:any=async()=>({context:{client,auditClient:{from:()=>({insert:async()=>({error:failAudit?{message:"audit failed"}:null})})},user:{id:"owner"},profile:{role:reviewer?"reviewer":"editor"}}});
  const run=(action="publish")=>handleCaseWorkflow(new Request("http://localhost/",{method:"POST",body:JSON.stringify({action,caseId:"case"})}),prepare);
  return {run,state,original,copied,removed,log};
}
for(const scenario of [{failCopy:2},{failPublish:true},{failAudit:true}]){
 Deno.test(`publication rollback ${JSON.stringify(scenario)}`,async()=>{
  const test=setup(scenario);const response=await test.run();assert(response.status===500);
  assert(test.state.status==="pending_review");
  assert(test.state.case_photo_pairs[0].before_public_path===null);
  assert(test.removed.length===test.copied.length,"all newly copied assets cleaned");
  const reset=test.log.findIndex(item=>item.table==="cases"&&item.values.status==="pending_review");
  const cleanup=test.log.findIndex(item=>item.remove);
  assert(reset>=0&&cleanup>reset,"restore status before deleting media");
 });
}
Deno.test("successful publication and invalid groups / reviewer guard",async()=>{
 const valid=setup();assert((await valid.run()).status===200);assert(valid.state.status==="published");assert(valid.removed.length===0);
 const incomplete=setup({incomplete:true});assert((await incomplete.run()).status===422);assert(incomplete.copied.length===0);
 const editor=setup({reviewer:false});assert((await editor.run()).status===403);assert(editor.copied.length===0);
});

Deno.test("unpublish and archive clean video, image and poster snapshots",async()=>{
 for(const action of ["unpublish","archive"]){
  const test=setup();test.state.status="published";
  Object.assign(test.state.case_photo_pairs[0],{before_public_path:"old-image",after_public_path:"old-video",published_before_media_type:"image",published_after_media_type:"video",after_poster_public_path:"old-poster"});
  assert((await test.run(action)).status===200);
  assert(test.removed.length===3);
  assert(test.log.some(item=>item.bucket==="case-video-published"&&item.remove.includes("old-poster")));
  assert(test.state.case_photo_pairs[0].after_public_path===null);
  assert(test.state.status===(action==="archive"?"archived":"changes_requested"));
 }
});
Deno.test("server verifies stored MP4 headers and rejects incomplete range responses",async()=>{
 const bytes=await Deno.readFile(new URL("../../../tools/fixtures/media-before.mp4",import.meta.url));
 const originalFetch=globalThis.fetch;let broken=false,readBytes=0;
 const client:any={storage:{from:()=>({
  list:async(_prefix:string,{search}:{search:string})=>({data:[{name:search,metadata:{mimetype:search.endsWith(".mp4")?"video/mp4":"image/webp",size:search.endsWith(".mp4")?bytes.length:100}}]}),
  createSignedUrl:async()=>({data:{signedUrl:"https://storage.example.test/qa.mp4"}})
 })}};
 const group:Group={layout_kind:"single",before_media_type:"video",before_private_path:"owner/case/movie.mp4",before_poster_private_path:"owner/case/poster.webp",before_video_meta:{duration:1,size:100,videoCodec:"h264",audioCodec:null}};
 globalThis.fetch=async(_input,init)=>{
  const match=new Headers(init?.headers).get("Range")!.match(/bytes=(\d+)-(\d+)/)!;
  const start=Number(match[1]),end=Number(match[2]);readBytes+=end-start+1;
  return new Response(bytes.slice(start,end+1),{status:broken?200:206,headers:{"Content-Range":`bytes ${start}-${end}/${bytes.length}`}});
 };
 try{
  await validateAssets(client,"case",[group]);
  assert(group.before_video_meta.duration===4&&group.before_video_meta.audioCodec==="aac","browser metadata is replaced with stored-file metadata");
  assert(readBytes<bytes.length/4);
  broken=true;let rejected=false;
  try{await validateAssets(client,"case",[group]);}catch{rejected=true;}
  assert(rejected,"range failures must fail closed");
 }finally{globalThis.fetch=originalFetch;}
});

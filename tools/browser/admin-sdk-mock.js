(function(){
 const id='11111111-1111-4111-8111-111111111111';
 const session={user:{id,email:'qa@example.test'},access_token:'qa-only-token'};
 const tables={profiles:[{id,display_name:'本機測試・非正式資料',role:'reviewer',active:true}],cases:[],case_photo_pairs:[],case_treatments:[],case_events:[]};
 const assets=new Map(), removed=[];
 window.__qa={tables,assets,removed};
 function builder(table){
  let action='select',values=null,filters=[],one=false,done=false,result;
  const query={select(){return this;},eq(key,value){filters.push(row=>row[key]===value);return this;},order(){return this;},single(){one=true;return this;},maybeSingle(){one=true;return this;},insert(value){action='insert';values=value;return this;},update(value){action='update';values=value;return this;},delete(){action='delete';return this;},then(resolve,reject){
   if(!done){done=true;let rows=tables[table].filter(row=>filters.every(fn=>fn(row)));
    if(action==='insert'){rows=(Array.isArray(values)?values:[values]).map(value=>({...value,id:value.id||crypto.randomUUID(),created_by:value.created_by||id,status:value.status||'draft',updated_at:new Date().toISOString()}));tables[table].push(...rows);}
    if(action==='update')rows.forEach(row=>Object.assign(row,values));
    if(action==='delete')tables[table]=tables[table].filter(row=>!rows.includes(row));
    if(table==='cases')rows=rows.map(row=>({...row,case_photo_pairs:tables.case_photo_pairs.filter(g=>g.case_id===row.id),case_treatments:tables.case_treatments.filter(t=>t.case_id===row.id),case_events:[]}));
    result={data:structuredClone(one?rows[0]:rows),error:null};
   }return Promise.resolve(result).then(resolve,reject);
  }};return query;
 }
 window.supabase={createClient:()=>({
  auth:{getSession:async()=>({data:{session},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},
  from:builder,
  rpc:async()=>({data:{treatments:[{id:'hydrafacial',name:'HydraFacial 海菲秀',categoryName:'測試分類'}]},error:null}),
  functions:{invoke:async(_name,{body})=>{
   const item=tables.cases.find(row=>row.id===body.caseId);
   if(body.action==='submit'){
    try{tables.case_photo_pairs.filter(g=>g.case_id===item.id).forEach(g=>window.CaseMedia.validateDraft(g));}catch(error){return{data:{error:error.message},error:null};}
    item.status='pending_review';
   }return{data:{status:item.status},error:null};
  }},
  storage:{from:bucket=>({
   upload:async(path,blob)=>{assets.set(`${bucket}/${path}`,blob);return {data:{path},error:null};},
   remove:async(paths)=>{paths.forEach(path=>{removed.push(`${bucket}/${path}`);assets.delete(`${bucket}/${path}`);});return{error:null};},
   createSignedUrl:async(path)=>{const blob=assets.get(`${bucket}/${path}`);return{data:{signedUrl:blob?URL.createObjectURL(blob):`/tools/fixtures/media-${path.endsWith('.mp4')?(path.includes('-after-')?'after.mp4':'before.mp4'):'photo.webp'}`},error:null};}
  })}
 })};
})();

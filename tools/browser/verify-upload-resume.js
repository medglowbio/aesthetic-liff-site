async (page)=>{
 await page.unrouteAll({behavior:'wait'});
 await page.route('https://*.supabase.co/**',route=>route.abort());

 await page.route('**/assets/config/supabase-config.js',r=>r.fulfill({body:'window.SUPABASE_CONFIG={url:"https://media-qa.supabase.co",publishableKey:"test"};',contentType:'application/javascript'}));
 await page.route('**/@supabase/supabase-js@2.115.0',r=>r.fulfill({path:'tools/browser/admin-sdk-mock.js',contentType:'application/javascript'}));
 const sessions=new Map(),tusCalls=[];let next=0,hold=true,patchSeen=false,release=null,dropOnce=true;
 await page.route('**/storage/v1/upload/resumable**',async route=>{
  const request=route.request(),method=request.method(),headers=request.headers();
  const cors={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-expose-headers':'Location,Upload-Offset,Upload-Length,Tus-Resumable','tus-resumable':'1.0.0'};
  tusCalls.push(method);
  if(method==='OPTIONS')return route.fulfill({status:204,headers:{...cors,'access-control-allow-methods':'POST,PATCH,HEAD,DELETE,OPTIONS'}});
  if(method==='POST'){
   const url=`https://media-qa.storage.supabase.co/storage/v1/upload/resumable/qa-${++next}`;
   const offset=request.postDataBuffer()?.length||0;sessions.set(url,{offset,length:Number(headers['upload-length'])});
   return route.fulfill({status:201,headers:{...cors,location:url,'upload-offset':String(offset)}});
  }
  const session=sessions.get(request.url());if(!session)return route.fulfill({status:404,headers:cors});
  if(method==='HEAD')return route.fulfill({status:200,headers:{...cors,'upload-offset':String(session.offset),'upload-length':String(session.length)}});
  if(method==='PATCH'){if(hold){patchSeen=true;await new Promise(resolve=>release=resolve);return route.abort('aborted');}if(dropOnce){dropOnce=false;return route.abort('internetdisconnected');}session.offset+=request.postDataBuffer()?.length||0;return route.fulfill({status:204,headers:{...cors,'upload-offset':String(session.offset)}});}
  return route.fulfill({status:204,headers:cors});
 });

 await page.goto('http://127.0.0.1:8767/admin/');await page.bringToFront();
 await page.locator('#new-case-button').click();
 await page.locator('#case-title').fill('取消續傳測試・非真實案例');
 await page.locator('[data-group-kind="0|single"]').click();
 await page.locator('[data-photo-input="0:before"]').setInputFiles('output/playwright/media-large.mp4');
 await page.waitForFunction(()=>document.querySelector('#photo-pairs video')&&!document.querySelector('#save-draft-button').disabled);
 await page.locator('#save-draft-button').click();
 for(let i=0;i<200&&!patchSeen;i++)await page.waitForTimeout(50);
 if(!patchSeen)throw Error('TUS did not reach second chunk');
 const progress=await page.locator('#media-upload-progress').innerText();
 await page.locator('#cancel-media-upload').click();release();hold=false;
 await page.waitForFunction(()=>!document.querySelector('#save-draft-button').disabled);
 const originalId=await page.evaluate(()=>window.__qa.tables.cases[0].id);
 await page.locator('#save-draft-button').click();
 await page.waitForFunction(()=>!document.querySelector('#save-draft-button').disabled);
 const state=await page.evaluate(()=>({cases:window.__qa.tables.cases,groups:window.__qa.tables.case_photo_pairs}));
 if(state.cases.length!==1||state.groups.length!==1||!state.groups[0].before_private_path.includes('/'+originalId+'/'))throw Error('Retry lost original draft identity '+JSON.stringify({state,tusCalls,toast:await page.locator('[role=status]').first().innerText()}));
 if(tusCalls.filter(m=>m==='POST').length!==1||!tusCalls.includes('HEAD'))throw Error('Retry started a new TUS object');
 return {progress,cancel:'passed',retry:'passed',simulatedDisconnection:'recovered',resume:'HEAD existing session then remaining PATCH',tusRequests:tusCalls,cases:state.cases.length};
}

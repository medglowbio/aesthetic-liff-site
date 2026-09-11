async (page)=>{
 await page.unrouteAll({behavior:'wait'});
 await page.route('https://*.supabase.co/**',route=>route.abort());

 await page.route('**/assets/config/supabase-config.js',r=>r.fulfill({body:'window.SUPABASE_CONFIG={url:"https://media-qa.supabase.co",publishableKey:"test"};',contentType:'application/javascript'}));
 await page.route('**/@supabase/supabase-js@2.115.0',r=>r.fulfill({path:'tools/browser/admin-sdk-mock.js',contentType:'application/javascript'}));
 const sessions=new Map(),tusCalls=[];let next=0;
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
  if(method==='PATCH'){session.offset+=request.postDataBuffer()?.length||0;return route.fulfill({status:204,headers:{...cors,'upload-offset':String(session.offset)}});}
  return route.fulfill({status:204,headers:cors});
 });
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:8767/admin/');await page.bringToFront();
 await page.locator('#new-case-button').click();
 await page.locator('#case-title').fill('混合素材上傳測試・非真實案例');
 await page.locator('#case-consent').check();
 await page.locator('[data-treatment-id=hydrafacial]').click();
 async function upload(index,side,type){
  const file=type==='image'?'tools/fixtures/media-photo.webp':`tools/fixtures/media-${side}.mp4`;
  await page.locator(`[data-photo-input="${index}:${side}"]`).setInputFiles(file);
  if(type==='image'){await page.locator('#crop-dialog').waitFor({state:'visible'});await page.locator('#confirm-crop').click();await page.locator('#crop-dialog').waitFor({state:'hidden'});}
  else await page.waitForFunction(({index,side})=>{const root=document.querySelector(`[data-photo-input="${index}:${side}"]`)?.parentElement;return root?.querySelector('video')&& !document.querySelector('#save-draft-button').disabled;},{index,side});
 }
 async function save(){await page.locator('#save-draft-button').click();await page.waitForFunction(()=>!document.querySelector('#save-draft-button').disabled);}
 await upload(0,'before','image');await upload(0,'after','video');await save();
 let stored=await page.evaluate(()=>window.__qa.tables.case_photo_pairs);
 if(stored.length!==1||stored[0].after_media_type!=='video'||!stored[0].after_poster_private_path)throw Error('Mixed media not persisted');
 await page.locator('[data-group-kind="0|single"]').click();
 if(!await page.locator('[data-photo-input="0:after"]').count())throw Error('Single switch silently removed media');
 await page.locator('[data-remove-media="0:after"]').click();await page.locator('[data-group-kind="0|single"]').click();
 await page.locator('[data-photo-edit="0:before"]').click();await page.locator('#confirm-crop').click();await page.locator('#crop-dialog').waitFor({state:'hidden'});await save();
 const combinations=[['comparison','video','image'],['single','video'],['comparison','image','image'],['comparison','image','video'],['comparison','video','video']];
 for(let i=0;i<combinations.length;i++){
  const [kind,before,after]=combinations[i],index=i+1;
  await page.locator('#add-photo-pair').click();if(kind==='single')await page.locator(`[data-group-kind="${index}|single"]`).click();
  await upload(index,'before',before);if(after)await upload(index,'after',after);
 }
 await upload(1,'before','image');await upload(1,'before','video');
 await save();stored=await page.evaluate(()=>window.__qa.tables.case_photo_pairs);
 if(stored.length!==6)throw Error('Multiple groups not saved');
 await page.locator('[data-poster-input="2:before"]').setInputFiles('tools/fixtures/media-photo.webp');
 await page.waitForFunction(()=>!document.querySelector('#save-draft-button').disabled);await save();
 await page.locator('[data-move-group="5|-1"]').click();await save();
 const moved=await page.evaluate(()=>window.__qa.tables.case_photo_pairs.find(g=>g.sort_order===4));
 if(moved.before_media_type!=='video'||moved.after_media_type!=='video')throw Error('Group order not saved');
 await page.locator('#add-photo-pair').click();await upload(6,'before','image');await save();
 stored=await page.evaluate(()=>window.__qa.tables.case_photo_pairs);
 if(stored.length!==7||!stored.some(g=>!g.after_private_path&&g.layout_kind==='comparison'))throw Error('Incomplete draft cannot be saved');
 await page.locator('#submit-review-button').click();await page.waitForFunction(()=>!document.querySelector('#save-draft-button').disabled);
 if(await page.evaluate(()=>window.__qa.tables.cases[0].status)!=='draft')throw Error('Incomplete draft submitted');
 await page.locator('[data-remove-pair="6"]').click();await save();
 await page.setViewportSize({width:1280,height:1000});

 await page.locator('#submit-review-button').click();
 await page.waitForFunction(()=>window.__qa.tables.cases[0].status==='pending_review');
 if(errors.length)throw Error(errors.join('\n'));
 return {persistedCombinations:6,sourceCrop:'preserved',singleSwitch:'requires removal',poster:'replaced',ordering:'saved',incompleteDraft:'saved; submit rejected',completeSubmit:'passed',tusRequests:tusCalls,oldAssetsCleaned:await page.evaluate(()=>window.__qa.removed.length),pageErrors:errors};
}

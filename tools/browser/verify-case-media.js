async (page) => {
 await page.unrouteAll({behavior:'wait'});
 await page.route('https://*.supabase.co/**',route=>route.abort());

  await page.route('**/sdk.js',r=>r.fulfill({body:'window.liff={init:async()=>{}};',contentType:'application/javascript'}));
  await page.route('**/fbevents.js',r=>r.fulfill({body:''}));
  await page.route('**/assets/js/supabase-cases.js*',r=>r.fulfill({body:'window.CaseRepository={configured:false};',contentType:'application/javascript'}));
  await page.route('**/assets/js/supabase-catalog.js',r=>r.fulfill({body:'window.CatalogRepository=null;',contentType:'application/javascript'}));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let requests=0;page.on('request',request=>{if(request.url().endsWith('.mp4'))requests++;});
  let stage=0;
  const wait=async(...args)=>{stage++;try{return await page.waitForFunction(...args);}catch(error){throw Error('stage '+stage+' '+JSON.stringify(await page.evaluate(()=>({current:currentCaseId,videos:[...document.querySelectorAll('#case-detail-pairs video')].map(v=>({t:v.currentTime,paused:v.paused,seeking:v.seeking,ready:v.readyState})),controls:document.getElementById('case-detail-pairs').innerText}))));}};
  await page.goto('http://127.0.0.1:8767');await page.bringToFront();
  await page.evaluate(async()=>{
    await document.fonts.ready;
    const photo={type:'image',src:'tools/fixtures/media-photo.webp',alt:'排版測試照片'};
    const video=side=>({type:'video',src:`tools/fixtures/media-${side}.mp4`,poster:`tools/fixtures/media-${side}-poster.webp`,meta:{duration:side==='before'?4:2}});
    const group=(layoutKind,before,after)=>({layoutKind,before,after,canvasRatio:'3:4',splitDirection:'horizontal',label:'測試素材・非真實案例'});
    const groups=[group('single',photo),group('single',video('before')),group('comparison',photo,photo),group('comparison',photo,video('after')),group('comparison',video('before'),photo),group('comparison',video('before'),video('after'))];
    const names=['單張照片','單支影片','術前照片＋術後照片','術前照片＋術後影片','術前影片＋術後照片','術前影片＋術後影片'];
    window.CASE_DATA=groups.map((g,i)=>({id:`QA-${i+1}`,title:names[i],status:'published',consentConfirmed:true,displayOrder:i,treatmentIds:['hydrafacial'],concernTags:['排版測試'],mediaGroups:[g],summary:'影片功能測試用素材，非真實醫療案例。'}));
    window.CASE_DATA.push({...window.CASE_DATA[0],id:'QA-multi',title:'多組素材混排',mediaGroups:groups});
    caseDataState='ready';switchPrimaryTab('cases');
  });
  await wait(()=>document.querySelector('#case-grid').classList.contains('is-masonry'));
  if(await page.locator('#case-grid .case-card').count()!==7)throw Error('Not all media combinations rendered');
  if(await page.locator('#case-grid video').count()!==0 || requests!==0)throw Error('List loads video content');
  for(const width of [375,430,719,720,1024]){
    await page.setViewportSize({width,height:950});
    await page.evaluate(async()=>{for(let i=0;i<5;i++)await new Promise(requestAnimationFrame);});
    const error=await page.evaluate(()=>{
      const grid=document.querySelector('#case-grid'),g=grid.getBoundingClientRect(),n=innerWidth>=720?3:2,bottoms=Array(n).fill(0),width=(g.width-9*(n-1))/n;
      for(const card of grid.children){const r=card.getBoundingClientRect(),y=Math.min(...bottoms),col=bottoms.indexOf(y);if(Math.abs(r.top-g.top-y)>.1||Math.abs(r.width-width)>.1||Math.abs(r.left-g.left-col*(width+9))>.1)return 'bad masonry';bottoms[col]=y+r.height+9;}
      return null;
    });if(error)throw Error(width+': '+error);
  }
  await page.evaluate(()=>openCaseDetail('QA-6'));
  const player=page.locator('#case-detail-pairs .case-media-player');
  await player.locator('[data-media-play]').click();
  await wait(()=>[...document.querySelectorAll('#case-detail-pairs video')].every(v=>!v.paused && v.currentTime>.2));
  let state=await player.locator('video').evaluateAll(v=>v.map(x=>({t:x.currentTime,muted:x.muted})));
  if(Math.abs(state[0].t-state[1].t)>.2)throw Error('paired drift');
  await player.evaluate(el=>{const button=el.querySelector('[data-media-play]');if(button.getAttribute('aria-pressed')==='true')button.click();const slider=el.querySelector('[data-media-seek]');slider.value='1';slider.dispatchEvent(new Event('input',{bubbles:true}));});
  await wait(()=>[...document.querySelectorAll('#case-detail-pairs video')].every(v=>Math.abs(v.currentTime-1)<.12&&!v.seeking));
  await player.locator('[data-media-mute]').click();
  state=await player.locator('video').evaluateAll(v=>v.map(x=>x.muted));
  if(!state[0]||state[1])throw Error('wrong audio source');
  await player.evaluate(el=>{
    const videos=[...el.querySelectorAll('video')], delayed=videos[1];
    Object.defineProperty(delayed,'readyState',{configurable:true,get:()=>2});
    el.querySelector('[data-media-play]').click();delayed.dispatchEvent(new Event('waiting'));
    if(videos.some(v=>!v.paused))throw Error('Buffering did not pause both videos');
    delete delayed.readyState;delayed.dispatchEvent(new Event('canplay'));
  });
  await wait(()=>[...document.querySelectorAll('#case-detail-pairs video')].every(v=>v.paused && v.currentTime>=1.9));
  if(Number(await player.locator('[data-media-seek]').getAttribute('max'))!==2)throw Error('not shorter timeline');
  await page.evaluate(()=>openCaseDetail('QA-4'));
  if(await page.locator('#case-detail-pairs video').count()!==1||await page.locator('#case-detail-pairs img').count()!==1)throw Error('mixed group changed');
  await page.locator('#case-detail-pairs video').evaluate(video=>video.play());
  await wait(()=>!document.querySelector('#case-detail-pairs video').paused);
  await page.evaluate(()=>closeCaseDetail());
  if(await page.locator('#case-detail-pairs video').getAttribute('src'))throw Error('video source not released');
  await page.evaluate(()=>openCaseDetail('QA-multi'));
  const all=page.locator('#case-detail-pairs .case-media-player');
  await all.nth(0).locator('[data-media-play]').click();
  await wait(()=>!document.querySelector('#case-detail-pairs video').paused);
  await all.nth(1).locator('[data-media-play]').click();
  await wait(()=>{const v=[...document.querySelectorAll('#case-detail-pairs video')];return v[0].paused&&!v[1].paused;});
  await page.evaluate(()=>{closeCaseDetail();document.querySelector('#case-result-summary').textContent='六種素材組合・測試資料，非真實案例';});
  if(errors.length)throw Error(errors.join('\n'));
  return {combinations:6,widths:[375,430,719,720,1024],listVideoRequests:0,sync:'play/pause/seek/audio/shorter ending and simulated buffering passed',mixed:'passed',multipleGroups:'exclusive playback passed',dispose:'passed',pageErrors:errors};
}

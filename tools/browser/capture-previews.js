async page=>{
 await page.bringToFront();
 await page.evaluate(()=>{closeCaseDetail();for(const item of window.CASE_DATA)for(const group of window.CaseMedia.groups(item))for(const side of window.CaseMedia.sides(group))if(group[side].type==='video')group[side].poster=`tools/fixtures/media-${side}-poster.webp`;renderCases();});
 for(const width of [375,1024]){
  await page.setViewportSize({width,height:1050});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(requestAnimationFrame);window.scrollTo(0,0);});
  await page.screenshot({path:`output/playwright/media-gallery-${width}.png`,timeout:15000});
 }
 await page.setViewportSize({width:430,height:930});
 await page.evaluate(()=>openCaseDetail('QA-6'));
 await page.waitForFunction(()=>Math.abs(document.querySelector('#case-detail-panel').getBoundingClientRect().left)<1);
 await page.screenshot({path:'output/playwright/media-paired-player.png',timeout:15000});
 return 'Captured 3 review previews';
}
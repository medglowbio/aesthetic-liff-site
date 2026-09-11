(function () {
  "use strict";
  let players = [];
  function dispose() { players.forEach(player => player.destroy()); players = []; }
  function mount(container) {
    dispose();
    players = [...container.querySelectorAll(".case-media-player")].map(element => {
      const videos = [...element.querySelectorAll("video")];
      const paired = videos.length === 2;
      const button = element.querySelector("[data-media-play]");
      const mute = element.querySelector("[data-media-mute]");
      const slider = element.querySelector("[data-media-seek]");
      const status = element.querySelector("[data-media-status]");
      const time = element.querySelector("[data-media-time]");
      const events = new AbortController();
      const suppressedPauses = new Set();
      let seekTarget = null;
      let finished = false;
      const listen = (target,name,fn) => target.addEventListener(name,fn,{signal:events.signal});
      let wanted = false, frame = 0, loading = false, dead = false, epoch = 0, internalPause = false, failed = false;
      const limit = () => Math.min(...videos.map(video => Number.isFinite(video.duration) ? video.duration : Number(video.dataset.duration) || 0));
      const format = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;
      function draw() {
        const max=limit(), current=Math.min(max,videos[0].currentTime||0);
        slider.max=String(max); if(document.activeElement!==slider)slider.value=String(current);
        time.textContent=`${format(current)} / ${format(max)}`;
        button.textContent=failed?"重新載入":wanted?(paired?"同步暫停":"暫停"):(paired?"同步播放":"播放影片");
        button.setAttribute("aria-pressed",String(wanted));
      }
      function pause(keepIntent=false) {
        if(!keepIntent){wanted=false;epoch++;}
        internalPause=true;videos.forEach(video=>{if(!video.paused)suppressedPauses.add(video);video.pause();});internalPause=false;
        if(!wanted){cancelAnimationFrame(frame);frame=0;if(!failed)status.textContent="";}draw();
      }
      function finishPlayback() {
        finished=true;pause();
        videos.forEach(video=>{if(Number.isFinite(video.duration)&&Math.abs(video.currentTime-limit())>.01)video.currentTime=limit();});
        draw();
      }
      function fail() {failed=true;pause();status.textContent="影片暫時無法播放，請按重新載入。";draw();}
      function claim() {players.forEach(player=>{if(player.element!==element)player.pause();});}
      function tick() {
        frame=0;if(dead||!wanted)return;
        if(limit()>0 && videos.some(video=>video.currentTime>=limit()-.025)) {
          finishPlayback();return;
        }
        if(videos.every(video=>!video.seeking && video.readyState>=3)) {
          if(paired && Math.abs(videos[0].currentTime-videos[1].currentTime)>.15) videos[1].currentTime=videos[0].currentTime;
          if(videos.some(video=>video.paused))resume();
        }
        draw();frame=requestAnimationFrame(tick);
      }
      function queueTick() {if(!frame&&wanted)frame=requestAnimationFrame(tick);}
      async function resume() {
        if(loading||!wanted||dead||videos.some(video=>video.seeking))return;
        if(finished || (limit()>0&&videos.some(video=>video.currentTime>=limit()-.025))){finishPlayback();return;}
        loading=true;const token=epoch;
        try {
          await Promise.all(videos.filter(video=>video.paused).map(video=>video.play()));
          if(dead||token!==epoch||!wanted){videos.forEach(video=>video.pause());if(finished&&!dead)finishPlayback();return;}
          status.textContent="";queueTick();
        }catch(error){if(!dead&&wanted&&token===epoch){if(error.name==="AbortError"){status.textContent="影片緩衝中…";queueTick();}else fail();}}
        finally{loading=false;}
      }
      function play() {
        const restart=finished || (limit()>0&&videos.some(video=>video.currentTime>=limit()-.025));
        claim();epoch++;wanted=true;finished=false;
        if(failed){videos.forEach(video=>{video.removeAttribute("src");video.load();});failed=false;}
        videos.forEach(video=>{
          if(!video.getAttribute("src")){video.src=video.dataset.src;video.load();}
          if(restart){seekTarget=0;video.currentTime=0;}
        });
        status.textContent="載入影片中…";draw();resume();queueTick();
      }
      listen(button,"click",()=>wanted?pause():play());
      listen(mute,"click",()=>{
        const audible=videos[videos.length-1];audible.muted=!audible.muted;
        if(paired)videos[0].muted=true;
        mute.textContent=audible.muted?"開啟聲音":"靜音";
      });
      listen(slider,"input",()=>{
        const target=Math.max(0,Math.min(limit(),Number(slider.value)));
        finished=false;seekTarget=target;pause(true);videos.forEach(video=>{if(!video.getAttribute("src")){video.src=video.dataset.src;video.load();}if(Number.isFinite(video.duration))video.currentTime=target;});draw();queueTick();
      });
      videos.forEach(video=>{
        const checkEnd=()=>{if(wanted&&!video.seeking&&limit()>0&&video.currentTime>=limit()-.025)finishPlayback();};
        listen(video,"loadedmetadata",()=>{if(seekTarget!==null)video.currentTime=Math.min(video.duration,seekTarget);draw();});listen(video,"timeupdate",()=>{draw();checkEnd();});
        listen(video,"error",fail);listen(video,"ended",checkEnd);
        listen(video,"waiting",()=>{if(paired&&wanted){pause(true);status.textContent="影片緩衝中…";queueTick();}});
        listen(video,"canplay",()=>{if(wanted&&videos.every(item=>item.readyState>=3&&!item.seeking))resume();});
        listen(video,"seeked",()=>{if(wanted&&videos.every(item=>!item.seeking&&item.readyState>=3))resume();});
        if(!paired) {
          listen(video,"play",()=>{claim();wanted=true;finished=false;queueTick();draw();});
          listen(video,"pause",()=>{if(suppressedPauses.delete(video))return;if(!internalPause&&!video.seeking){wanted=false;epoch++;draw();}});
          listen(video,"volumechange",()=>{mute.textContent=video.muted?"開啟聲音":"靜音";});
          // Native controls must be usable as soon as the detail opens.
          video.preload="metadata";video.src=video.dataset.src;
        }
      });
      draw();
      return {element,pause,destroy(){dead=true;pause();events.abort();videos.forEach(video=>{video.removeAttribute("src");video.load();});}};
    });
  }
  document.addEventListener("visibilitychange",()=>{if(document.hidden)players.forEach(player=>player.pause());});
  window.addEventListener("pagehide",dispose);
  window.CasePlayer=Object.freeze({mount,dispose});
})();

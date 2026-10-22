/* Shared first-party usage measurement. Never reads form values, account data or URL queries. */
(()=>{
 'use strict';
 const script=document.currentScript,site=script?.dataset.site;
 if(site==='housemanager'&&location.pathname.startsWith('/admin/hub'))return;
 if(!site||window.__mikekAnalyticsLoaded||window.self!==window.top||['localhost','127.0.0.1'].includes(location.hostname)||navigator.doNotTrack==='1'||navigator.globalPrivacyControl)return;
 window.__mikekAnalyticsLoaded=true;
 const API='https://us-central1-referrals-55bee.cloudfunctions.net/hub/event';
 const slug=s=>String(s||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').slice(0,70);
 const page=()=>script.dataset.page||('/'+location.pathname.split('/').filter(Boolean).slice(0,site==='pupsnchill'?2:1).join('/'));
 const uuid=()=>crypto.randomUUID();let visitor=uuid();
 try{const old=JSON.parse(localStorage.getItem('mk-visitor')||'null');if(old&&old.until>Date.now()&&/^[a-zA-Z0-9_-]{16,64}$/.test(old.id))visitor=old.id;else localStorage.setItem('mk-visitor',JSON.stringify({id:visitor,until:Date.now()+30*86400000}));}catch{}
 let visit,start,last,lastInput;
 function begin(){start=performance.now();last=start;lastInput=start;visit={id:uuid(),visitor,site,page:page(),referrer:document.referrer?new URL(document.referrer).origin:'',device:/iPad|Tablet/i.test(navigator.userAgent)?'Tablet':/Mobile|Android|iPhone/i.test(navigator.userAgent)?'Mobile':'Desktop',activeSeconds:0,scroll:0,clicks:[]};send();}
 function tick(){const now=performance.now();if(document.visibilityState==='visible'&&now-lastInput<60000)visit.activeSeconds+=Math.min(5,(now-last)/1000);last=now;visit.scroll=Math.max(visit.scroll,Math.round(Math.min(1,(scrollY+innerHeight)/Math.max(document.documentElement.scrollHeight,1))*100));}
 function send(){tick();fetch(API,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({...visit,activeSeconds:Math.floor(visit.activeSeconds)}),keepalive:true}).catch(()=>{});}
 function track(event){if(!event||visit.clicks.length>=50)return;const id=slug(event.id);if(!id)return;visit.clicks.push({id,ms:Math.round(performance.now()-start),kind:event.kind||'action',item:slug(event.item),label:String(event.label||id).slice(0,100)});send();}
 window.MikeKAnalytics={track};begin();
 for(const event of ['pointerdown','keydown','scroll','touchstart'])addEventListener(event,()=>{lastInput=performance.now();},{passive:true});
 document.addEventListener('click',e=>{
  const target=e.target instanceof Element?e.target:null;if(!target)return;
  const marked=target.closest('[data-analytics-id]');
  if(marked){track({id:marked.dataset.analyticsId,item:marked.dataset.analyticsItem,kind:marked.dataset.analyticsKind,label:marked.dataset.analyticsLabel});return;}
  const a=target.closest('a');
  if(!a){
   const button=target.closest('button,[role="button"],input[type="submit"],input[type="button"]');
   if(!button||site==='favorites'&&button.matches('.card'))return;
   const taskActions={'tab-list':'List','tab-cal':'Calendar','tab-proj':'Projects',ava:'Account',fbBtn:'Feedback',aiBtn:'Assistant',gGoogle:'Google sign-in',gSubmit:'Sign in',updateNow:'Update app',installHow:'Install help'};
   const label=site==='tasks'?taskActions[button.id]:null;
   track({id:label?'tasks-'+slug(label):site+'-button',kind:'action',label:label||'Button interaction'});return;
  }
  const custom=a.dataset.homeLink;if(custom){track({id:custom,item:custom,kind:'navigation',label:a.querySelector('.card-title')?.textContent||custom});return;}
  if(a.closest('.socials')){track({id:'social-'+slug(a.title),kind:'outbound',label:a.title});return;}
  if(a.classList.contains('pay-direct')){track({id:'pay',kind:'navigation',label:'Pay'});return;}
  let url;try{url=new URL(a.href);}catch{return;}if(!['https:','http:'].includes(url.protocol))return;
  const sheet=a.closest('#sheet');if(sheet?.dataset.analyticsItem){track({id:'favorite-out-'+sheet.dataset.analyticsItem,item:sheet.dataset.analyticsItem,kind:'outbound',label:sheet.dataset.analyticsLabel});return;}
  const outbound=url.origin!==location.origin;
  const destination=outbound?url.hostname:('/'+url.pathname.split('/').filter(Boolean).slice(0,2).join('/'));
  track({id:slug((outbound?'out-':'nav-')+destination),kind:outbound?'outbound':'navigation',label:(outbound?'Visit ':'Open ')+destination});
 });
 (window.__mkAnalyticsQueue||[]).forEach(track);window.__mkAnalyticsQueue=[];
 setInterval(()=>{if(page()!==visit.page){send();begin();}else tick();},5000);
 setInterval(()=>{if(document.visibilityState==='visible'&&performance.now()-lastInput<60000)send();},30000);
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')send();else last=performance.now();});addEventListener('pagehide',send);
})();

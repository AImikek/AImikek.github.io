const OWNERS = new Set(['michaelkrilivsky@gmail.com','m@mikek.ai']);
function owner(token) { return !!(token && token.email_verified && OWNERS.has(String(token.email).toLowerCase())); }
function url(value, image=false) {
  if (typeof value !== 'string' || value.length > (image ? 90000 : 2048)) throw Error('Invalid URL');
  if (image && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  if (!value && image) return '';
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\x00-\x20]/.test(value)) return value;
  const u = new URL(value); if(u.protocol !== 'https:' || u.username || u.password) throw Error('Use an https:// URL or a site path beginning with /.');
  return u.href;
}
const text=(s,n)=>String(s??'').trim().slice(0,n);
function cleanConfig(input) {
  if(!input || !Array.isArray(input.links) || input.links.length>80) throw Error('Use at most 80 links.');
  const ids=new Set();
  const links=input.links.map(l=>{
    if(!l || !/^[a-zA-Z0-9_-]{1,70}$/.test(l.id) || ids.has(l.id)) throw Error('Invalid or duplicate link ID'); ids.add(l.id);
    if(!text(l.title,160))throw Error('Each link needs a headline.');
    return {id:l.id,title:text(l.title,160),description:text(l.description,300),header:text(l.header,80),href:url(l.href),logo:url(l.logo||'',true),icon:['mk','star','pnc','pickleball','booking','pnc-ig','mlp','equinox','image'].includes(l.icon)?l.icon:'image',badge:text(l.badge,30),featured:!!l.featured,hidden:!!l.hidden};
  });
  const config={links,followers:text(input.followers,100),houseUrl:input.houseUrl?url(input.houseUrl):''};
  if(Buffer.byteLength(JSON.stringify(config))>700000)throw Error('Logos are too large. Use smaller images.');
  return config;
}
function cleanVisit(b, now=Date.now()) {
  if(!b || !/^[a-zA-Z0-9_-]{16,64}$/.test(b.id)||!/^[a-zA-Z0-9_-]{16,64}$/.test(b.visitor))throw Error('Invalid visit');
  let source='Direct'; try{source=new URL(b.referrer).hostname.slice(0,120);}catch{}
  return {id:b.id,visitor:b.visitor,source,device:['Mobile','Tablet','Desktop'].includes(b.device)?b.device:'Desktop',activeSeconds:Math.min(1800,Math.max(0,Math.floor(Number(b.activeSeconds)||0))),scroll:Math.min(100,Math.max(0,Number(b.scroll)||0)),clicks:(Array.isArray(b.clicks)?b.clicks:[]).slice(0,50).filter(c=>c&&/^[a-zA-Z0-9_-]{1,70}$/.test(c.id)&&Number.isFinite(c.ms)).map(c=>({id:c.id,ms:Math.min(1800000,Math.max(0,Math.floor(c.ms)))})),updatedAt:now};
}
function mergeVisit(old,next,now=Date.now()) {
  if(!old)return {...next,startedAt:now};
  // A visit cannot change identity/source or decrease counters on retried beacons.
  if(old.visitor!==next.visitor||(old.site||'home')!==(next.site||'home')||(old.origin||'https://mikek.ai')!==(next.origin||'https://mikek.ai'))throw Error('Visit identity mismatch');
  const elapsed=Math.max(0,(now-old.startedAt)/1000)+30;
  return {...old,activeSeconds:Math.max(old.activeSeconds,Math.min(next.activeSeconds,elapsed)),scroll:Math.max(old.scroll,next.scroll),clicks:next.clicks.length>old.clicks.length?next.clicks:old.clicks,updatedAt:now};
}
function summarize(visits, links=[]) {
  const totals={views:visits.length,visitors:new Set(visits.map(v=>v.visitor)).size,clicks:0,clickedVisits:0,activeSeconds:0,firstClickSeconds:0,scroll:0};
  const byDay=Object.create(null),byHour=Object.create(null),byLink=Object.create(null),sources=Object.create(null),devices=Object.create(null);const titles=Object.fromEntries(links.map(l=>[l.id,l.title]));
  const zone={timeZone:'America/New_York'};
  const dayFormat=new Intl.DateTimeFormat('en-CA',{...zone,year:'numeric',month:'2-digit',day:'2-digit'}),hourFormat=new Intl.DateTimeFormat('en-US',{...zone,hour:'2-digit',hourCycle:'h23'});
  for(const v of visits){
    const day=dayFormat.format(v.startedAt);
    byDay[day]??={views:0,clicks:0};byDay[day].views++;
    sources[v.source]=(sources[v.source]||0)+1;devices[v.device]=(devices[v.device]||0)+1;
    totals.activeSeconds+=v.activeSeconds||0;totals.scroll+=v.scroll||0;
    if(v.clicks?.length){totals.clickedVisits++;totals.firstClickSeconds+=v.clicks[0].ms/1000;}
    for(const c of v.clicks||[]){totals.clicks++;const clickDay=dayFormat.format(v.startedAt+c.ms);byDay[clickDay]??={views:0,clicks:0};byDay[clickDay].clicks++;byLink[c.id]??={id:c.id,title:titles[c.id]||c.id,clicks:0};byLink[c.id].clicks++;
      const hour=hourFormat.format(v.startedAt+c.ms);byHour[hour]=(byHour[hour]||0)+1;}
  }
  return {totals:{...totals,clickRate:totals.views?totals.clickedVisits/totals.views*100:0,averageActiveSeconds:totals.views?totals.activeSeconds/totals.views:0,averageFirstClickSeconds:totals.clickedVisits?totals.firstClickSeconds/totals.clickedVisits:0,averageScroll:totals.views?totals.scroll/totals.views:0},byDay,byHour,byLink:Object.values(byLink).sort((a,b)=>b.clicks-a.clicks),sources,devices};
}
module.exports={owner,url,cleanConfig,cleanVisit,mergeVisit,summarize};

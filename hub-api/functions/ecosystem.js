const sites=require('./sites.json');
const catalog=require('./catalog.json');
const {summarize}=require('./model');
const canonical=o=>o.replace('://www.', '://');
const byFavorite=Object.assign(Object.create(null),Object.fromEntries(catalog.map(c=>[c.id,c])));
function eventContext(body,origin){
 const site=sites.find(s=>s.id===(body.site||'home'));
 if(!site||!site.origins.includes(origin))throw Error('Invalid site origin');
 return {site:site.id,origin:canonical(origin),page:typeof body.page==='string'&&/^\/[a-zA-Z0-9_./:-]{0,120}$/.test(body.page)?body.page:'/'};
}
function enrichClicks(clicks,raw){
 return clicks.map((c,i)=>{
  const original=raw.find(x=>x&&x.id===c.id&&Math.min(1800000,Math.max(0,Math.floor(x.ms)))===c.ms)||{};
  const item=byFavorite[original.item];
  return {...c,kind:['open','filter','outbound','navigation','action'].includes(original.kind)?original.kind:'navigation',item:item?.id||'',category:item?.category||'',label:item?.name||String(original.label||c.id).slice(0,100)};
 });
}
function networkReport(visits,links,siteId='all'){
 visits=visits.map(v=>(v.site==='mikek-pages'&&['/guest.html','/register.html'].includes(v.page))?{...v,site:v.page==='/guest.html'?'guest':'guest-register'}:v);
 const selected=siteId==='all'?visits:visits.filter(v=>(v.site||'home')===siteId);
 const normalize=v=>({...v,visitor:(v.origin||'https://mikek.ai')+'|'+v.visitor});
 const result=summarize(selected.map(normalize),links);
 const known=Object.assign(Object.create(null),Object.fromEntries(links.map(l=>[l.id,l.title])));
 const labels=Object.create(null);for(const v of selected)for(const c of v.clicks||[])labels[c.id]??=c.label;
 result.byLink=result.byLink.map(l=>({...l,title:known[l.id]||labels[l.id]||l.id}));
 const perSite=sites.map(site=>{
  const rows=visits.filter(v=>(v.site||'home')===site.id),s=summarize(rows.map(normalize),links);
  return {id:site.id,name:site.name,url:site.url,...s.totals,lastSeen:Math.max(0,...rows.map(v=>v.updatedAt||v.startedAt))};
 });
 const favorites=catalog.map(c=>({...c,opens:0,outbound:0,clicks:0,visitors:new Set()}));
 const byId=Object.assign(Object.create(null),Object.fromEntries(favorites.map(c=>[c.id,c])));
 const pages={};
 for(const v of selected){
  const key=(v.site||'home')+':'+(v.page||'/');pages[key]??={site:v.site||'home',page:v.page||'/',views:0,clicks:0};pages[key].views++;pages[key].clicks+=(v.clicks||[]).length;
 }
 for(const v of visits){
  for(const c of v.clicks||[]){const f=byId[c.item||c.id];if(!f)continue;f.clicks++;if(c.kind==='outbound')f.outbound++;else f.opens++;f.visitors.add((v.origin||'https://mikek.ai')+'|'+v.visitor);}
 }
 const favoritesRows=favorites.map(f=>({...f,visitors:f.visitors.size}));
 const categories={};for(const f of favoritesRows){categories[f.category]??={name:f.category,listings:0,opens:0,outbound:0,clicks:0};const c=categories[f.category];c.listings++;c.opens+=f.opens;c.outbound+=f.outbound;c.clicks+=f.clicks;}
 return {...result,site:siteId,perSite,favorites:favoritesRows,categories:Object.values(categories),pages:Object.values(pages).sort((a,b)=>b.views-a.views)};
}
function referralReport(docs,total){
 const categoryFor=Object.fromEntries(catalog.map(c=>[c.name.toLowerCase(),c.category]));
 const rows=docs.map(doc=>{const r=doc.data(),business=String(r.business||'Unspecified').slice(0,150);return {id:doc.id,business,type:business==='Partner Application'?'partner':'referral',category:business==='Partner Application'?'Partners':categoryFor[business.toLowerCase()]||'Other',name:String(r.name||'').slice(0,200),email:String(r.email||'').slice(0,250),phone:String(r.phone||'').slice(0,80),location:String(r.location||'').slice(0,200),createdAt:r.created_at?.toMillis?.()||Date.parse(r.created_at)||0,details:r.details&&typeof r.details==='object'?Object.fromEntries(Object.entries(r.details).slice(0,40).map(([k,v])=>[k.slice(0,80),String(v).slice(0,5000)])):{}};});
 const byBusiness=Object.create(null),byCategory=Object.create(null);for(const r of rows){byBusiness[r.business]=(byBusiness[r.business]||0)+1;byCategory[r.category]=(byCategory[r.category]||0)+1;}
 return {rows,total,loaded:rows.length,capped:total>rows.length,partners:rows.filter(r=>r.type==='partner').length,referrals:rows.filter(r=>r.type==='referral').length,byBusiness,byCategory,catalog};
}
module.exports={sites,catalog,eventContext,enrichClicks,networkReport,referralReport};

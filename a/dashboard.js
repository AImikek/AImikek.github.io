const $=s=>document.querySelector(s);
export function card(value,label,href){const n=document.createElement(href?'a':'div');n.className='metric'+(href?' metric-link':'');if(href)n.href=href;const v=document.createElement('strong'),l=document.createElement('span');v.textContent=String(value);l.textContent=label;n.append(v,l);if(href){const arrow=document.createElement('i');arrow.textContent='↗';arrow.setAttribute('aria-hidden','true');n.append(arrow);}return n;}
export function route(){const [section,query='']=location.hash.slice(1).split('?');return {section:section||'overview',params:new URLSearchParams(query)};}
export function trend(byDay,days){
 const target=$('#overview-chart');target.replaceChildren();const now=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
 const end=Date.parse(now+'T12:00:00Z'),rows=Array.from({length:days},(_,i)=>{const date=new Date(end-(days-1-i)*86400000).toISOString().slice(0,10);return {date,...{views:0,clicks:0},...byDay[date]};});
 const max=Math.max(1,...rows.flatMap(r=>[r.views,r.clicks]));
 for(const r of rows){const column=document.createElement('div');column.className='trend-column';column.setAttribute('role','img');column.setAttribute('aria-label',`${r.date}: ${r.views} visits, ${r.clicks} clicks`);column.title=`${r.date} · ${r.views} visits · ${r.clicks} clicks`;const bars=document.createElement('div');bars.className='trend-pair';for(const key of ['views','clicks']){const b=document.createElement('i');b.className=key;b.style.height=Math.max(r[key]?3:0,r[key]/max*140)+'px';bars.append(b);}const label=document.createElement('small');label.textContent=r.date.slice(5);column.append(bars,label);target.append(column);}
 $('#trend-note').textContent=`Daily measured activity · New York time · last ${days} days. Tracking starts when each site is connected.`;
}
const button=$('#theme-toggle');
function theme(value){document.documentElement.dataset.theme=value;button.textContent=value==='dark'?'☀ Light mode':'☾ Dark mode';button.setAttribute('aria-label','Switch to '+(value==='dark'?'light':'dark')+' mode');button.setAttribute('aria-pressed',String(value==='dark'));}
theme(document.documentElement.dataset.theme||'dark');button.onclick=()=>{const value=document.documentElement.dataset.theme==='dark'?'light':'dark';theme(value);try{localStorage.setItem('mikek-admin-theme',value);}catch{}};

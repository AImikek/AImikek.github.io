const API='https://us-central1-referrals-55bee.cloudfunctions.net/hub';
const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
function symbol(id){const s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('class','icon'+(id==='mk'?' mk-icon':''));s.setAttribute('aria-hidden','true');const u=document.createElementNS(s.namespaceURI,'use');u.setAttribute('href','#'+id);s.append(u);return s;}
function safeURL(s,image=false){try{if(image&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s))return s;const u=new URL(s,location.origin);if(u.protocol==='https:'||(s.startsWith('/')&&!s.startsWith('//')&&!s.includes('\\')))return u.href;}catch{}return '';}
export function card(l){
 const a=node('a','link-card'+(l.featured?' featured':''));a.href=safeURL(l.href)||'/';a.dataset.homeLink=l.id;
 if(new URL(a.href).origin!==location.origin){a.target='_blank';a.rel='noopener noreferrer';}
 const icon=node('span','card-icon '+({mk:'chrome',star:'chrome',pnc:'logo-icon pups-logo',pickleball:'logo-icon pickleball-logo',booking:'booking-logo composite-logo','pnc-ig':'pups-logo composite-logo',mlp:'logo-icon mlp-logo'}[l.icon]||'logo-icon'));
 if(l.icon==='mk')icon.append(symbol('mk'));
 else if(l.icon==='star'){const star=document.createElementNS('http://www.w3.org/2000/svg','svg');star.setAttribute('viewBox','0 0 24 24');star.setAttribute('class','icon');star.setAttribute('aria-hidden','true');const path=document.createElementNS(star.namespaceURI,'path');path.setAttribute('d','m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z');star.append(path);icon.append(star);}
 else if(safeURL(l.logo,true)){const img=node('img');img.src=safeURL(l.logo,true);img.alt='';img.width=48;img.height=48;img.loading='lazy';if(l.icon==='booking'){const wrap=node('span','booking-photo');wrap.append(img);icon.append(wrap);}else icon.append(img);if(l.icon==='equinox')icon.style.background='#183247';
  if(['booking','pnc-ig'].includes(l.icon)){icon.classList.add('composite-logo');const badge=node('span','logo-overlay '+(l.icon==='booking'?'calendar-overlay':'instagram-overlay'));badge.append(symbol(l.icon==='booking'?'calendar':'instagram'));icon.append(badge);}}
 else icon.textContent=(l.title||'?').slice(0,1);
 const copy=node('span','card-copy');if(l.header)copy.append(node('span','card-kicker',l.header));const title=node('span','card-title',l.title);if(l.badge)title.append(' ',node('span','badge',l.badge));copy.append(title);if(l.description)copy.append(node('span','card-description',l.description));
 const arrow=node('span','card-arrow');arrow.append(symbol('arrow'));a.append(icon,copy,arrow);return a;
}
(async()=>{try{const r=await fetch(API+'/public',{signal:AbortSignal.timeout(5000)});if(r.ok){const c=await r.json();if(Array.isArray(c.links)){document.querySelector('.link-list').replaceChildren(...c.links.filter(l=>!l.hidden).map(card));document.querySelector('.follower-count').textContent=c.followers||'';}}}catch{/* Static links stay available if the service cannot be reached. */}})();

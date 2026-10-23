const {createHash,randomBytes,timingSafeEqual}=require('node:crypto');
const sources=['sweatpals','sponsorship'];
const hash=s=>createHash('sha256').update(s).digest('hex');
const text=(v,n=200)=>typeof v==='string'?v.trim().slice(0,n):'';
function date(v){const n=typeof v==='number'?v:Date.parse(v);if(!Number.isFinite(n)||n<946684800000||n>Date.now()+300000)throw Error('Use a valid registration/order timestamp.');return n;}
function cleanRecord(input,source){
 if(!sources.includes(source)||!input||typeof input!=='object')throw Error('Unknown source.');
 const r={source,kind:text(input.kind),id:text(input.id),eventId:text(input.eventId),eventName:text(input.eventName),tier:text(input.tier),name:text(input.name),email:text(input.email,254),status:text(input.status),createdAt:date(input.createdAt),updatedAt:date(input.updatedAt)};
 if(!r.id||!r.eventId||!r.eventName||r.updatedAt<r.createdAt)throw Error('Record ID, event, and ordered timestamps are required.');
 if(r.kind==='ticket'&&source==='sweatpals'){
  if(!['valid','cancelled','refunded'].includes(r.status)||typeof input.checkedIn!=='boolean'||!['free','paid','comp'].includes(input.ticketType))throw Error('Ticket status, ticket type and check-in state are required.');
  r.checkedIn=input.checkedIn;r.ticketType=input.ticketType;
 }else if(r.kind==='order'){
  if(!['paid','partially_refunded','refunded','pending','failed'].includes(r.status))throw Error('Unknown order status.');
  if(!Number.isSafeInteger(input.amountCents)||input.amountCents<0||!Number.isSafeInteger(input.refundedCents)||input.refundedCents<0||input.refundedCents>input.amountCents)throw Error('Use integer currency cents and a valid refunded amount.');
  r.currency=text(input.currency).toUpperCase();if(!/^[A-Z]{3}$/.test(r.currency))throw Error('Currency is required.');
  if(r.status==='refunded'&&input.refundedCents!==input.amountCents||r.status==='paid'&&input.refundedCents!==0||r.status==='partially_refunded'&&!(input.refundedCents>0&&input.refundedCents<input.amountCents))throw Error('Order status must match the refunded amount.');
  r.amountCents=input.amountCents;r.refundedCents=input.refundedCents;
 }else throw Error('Unknown record kind.');
 return r;
}
function summarize(records,days,now=Date.now()){
 const since=now-days*86400000,selected=records.filter(r=>r.createdAt>=since),tickets=selected.filter(r=>r.kind==='ticket'),orders=selected.filter(r=>r.kind==='order');
 const active=tickets.filter(r=>r.status==='valid'),currencies={},byEvent=Object.create(null);
 for(const r of selected){const k=r.eventId;if(!byEvent[k])byEvent[k]={id:k,name:r.eventName,tickets:0,checkedIn:0,orders:0};if(r.kind==='ticket'&&r.status==='valid'){byEvent[k].tickets++;byEvent[k].checkedIn+=r.checkedIn?1:0;}if(r.kind==='order'&&['paid','partially_refunded'].includes(r.status))byEvent[k].orders++;}
 for(const r of orders.filter(r=>['paid','partially_refunded','refunded'].includes(r.status))){const c=currencies[r.currency]||={gross:0,refunds:0,collected:0};c.gross+=r.amountCents;c.refunds+=r.refundedCents;c.collected+=r.amountCents-r.refundedCents;}
 return {tickets:active.length,free:active.filter(r=>r.ticketType==='free').length,paid:active.filter(r=>r.ticketType==='paid').length,comp:active.filter(r=>r.ticketType==='comp').length,checkedIn:active.filter(r=>r.checkedIn).length,cancelled:tickets.filter(r=>r.status!=='valid').length,paidOrders:orders.filter(r=>['paid','partially_refunded'].includes(r.status)).length,pendingOrders:orders.filter(r=>r.status==='pending').length,currencies,byEvent:Object.values(byEvent),rows:selected.sort((a,b)=>b.updatedAt-a.updatedAt),saved:records.length};
}
function validKey(key,digest){if(!key||!digest||typeof digest!=='string'||!/^[a-f0-9]{64}$/.test(digest))return false;return timingSafeEqual(Buffer.from(hash(key),'hex'),Buffer.from(digest,'hex'));}
function createEventService(db){
 const connection=source=>db.doc('hubEventConnections/'+source),records=db.collection('hubEventRecords');
 return {
 async connect(source,uid){if(!sources.includes(source))throw Error('Unknown source');const key=randomBytes(32).toString('hex');await db.runTransaction(async tx=>{const ref=connection(source),old=await tx.get(ref);if(old.exists&&old.data().keyHash)throw Error('A connection key already exists.');tx.set(ref,{keyHash:hash(key),createdAt:Date.now(),createdBy:uid,lastReceivedAt:null});});return {key};},
 async receive(source,authorization,body){
  if(!sources.includes(source))return {status:404,error:'Unknown source'};
  const ref=connection(source),c=await ref.get();if(!c.exists||!validKey((authorization||'').replace(/^Bearer /,''),c.data().keyHash))return {status:401,error:'Invalid integration key'};
  if(!Array.isArray(body?.records)||!body.records.length||body.records.length>100)return {status:400,error:'Send 1–100 normalized records.'};
  let rows;try{rows=body.records.map(r=>cleanRecord(r,source));if(new Set(rows.map(r=>r.kind+'|'+r.id)).size!==rows.length)throw Error('Duplicate IDs in batch.');}catch(e){return {status:400,error:e.message};}
  const result=await db.runTransaction(async tx=>{const fresh=await tx.get(ref);if(!validKey((authorization||'').replace(/^Bearer /,''),fresh.data()?.keyHash))return null;
   const refs=rows.map(r=>records.doc(hash(source+'|'+r.kind+'|'+r.id))),old=await Promise.all(refs.map(x=>tx.get(x)));let updated=0;
   rows.forEach((r,i)=>{if(!old[i].exists||r.updatedAt>old[i].data().updatedAt){tx.set(refs[i],r);updated++;}});
   tx.set(ref,{lastReceivedAt:Date.now()},{merge:true});return updated;});
  return result===null?{status:401,error:'Invalid integration key'}:{status:200,accepted:result,unchanged:rows.length-result};
 },
 async report(days){const result={days,fetchedAt:Date.now()};for(const source of sources){const [c,s]=await Promise.all([connection(source).get(),records.where('source','==',source).limit(5001).get()]);const config=c.data()||{};result[source]={configured:!!config.keyHash,connected:!!config.lastReceivedAt,lastReceivedAt:config.lastReceivedAt||null,capped:s.size>5000,...summarize(s.docs.slice(0,5000).map(d=>d.data()),days),history:summarize(s.docs.slice(0,5000).map(d=>d.data()),36500)};}return result;}
 };
}
module.exports={cleanRecord,summarize,validKey,createEventService};

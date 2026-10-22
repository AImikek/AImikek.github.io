const {onRequest}=require('firebase-functions/v2/https');
const {initializeApp}=require('firebase-admin/app');
const {getAuth}=require('firebase-admin/auth');
const {getFirestore}=require('firebase-admin/firestore');
const {createHash}=require('node:crypto');
const {owner,cleanConfig,cleanVisit,mergeVisit,summarize}=require('./model');
const seed=require('./seed.json');
const {defineSecret}=require('firebase-functions/params');
const nvmToken=defineSecret('NVM_AIRTABLE_READ_TOKEN');
const {nvmSummary,duaSummary,guestSummary}=require('./forms');
const {guestRecords}=require('./guest-records');
const {sites,eventContext,enrichClicks,networkReport,referralReport}=require('./ecosystem');
const app=initializeApp();const tasks=initializeApp({projectId:'mikek-tasks'},'tasks-auth');
const db=getFirestore(app);const configRef=db.doc('adminHub/config');
const allowedOrigin=o=>sites.some(s=>s.origins.includes(o))||/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
exports.hub=onRequest({region:'us-central1',memory:'256MiB',secrets:[nvmToken],timeoutSeconds:30,maxInstances:3,minInstances:0},async(req,res)=>{
  const origin=req.get('origin')||'';res.set('Cache-Control','no-store');res.set('X-Content-Type-Options','nosniff');
  if(origin&&!allowedOrigin(origin))return res.status(403).json({error:'Origin not allowed'});
  if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}
  res.set('Access-Control-Allow-Headers','Content-Type, Authorization');res.set('Access-Control-Allow-Methods','GET, PUT, POST, OPTIONS');
  if(req.method==='OPTIONS')return res.status(204).end();
  const path=req.path.replace(/\/+$/,'')||'/';
  try{
    if(path==='/health')return res.json({ok:true});
    if(path==='/public'&&req.method==='GET'){
      const s=await configRef.get(),c=s.exists?s.data():{...seed,revision:0};
      res.set('Cache-Control','public,max-age=30');return res.json({links:c.links.filter(l=>!l.hidden),followers:c.followers,revision:c.revision});
    }
    if(path==='/event'&&req.method==='POST'){
      if(!origin||req.get('DNT')==='1'||/bot|crawler|spider/i.test(req.get('user-agent')||''))return res.status(204).end();
      if(Buffer.byteLength(JSON.stringify(req.body||{}))>12000)return res.status(413).end();
      let v;try{v={...cleanVisit(req.body),...eventContext(req.body,origin)};v.clicks=enrichClicks(v.clicks,req.body.clicks||[]);}catch{return res.status(400).json({error:'Invalid event'});}
      // Short-lived salted network bucket: no raw IPs or full referrer URLs are stored.
      const bucket=createHash('sha256').update((req.ip||'unknown')+new Date().toISOString().slice(0,13)).digest('hex');
      const rate=db.doc('hubRate/'+bucket),visit=db.doc('hubVisits/'+(req.body.site?createHash('sha256').update(v.origin+'|'+v.id).digest('hex'):v.id));
      const accepted=await db.runTransaction(async tx=>{
        const [r,s]=await Promise.all([tx.get(rate),tx.get(visit)]);if((r.data()?.n||0)>=600)return false;
        if(s.exists&&Date.now()-s.data().startedAt>2*3600000)return false;
        const next=mergeVisit(s.exists?s.data():null,v);if(!s.exists){next.activeSeconds=Math.min(30,next.activeSeconds);next.clicks=next.clicks.filter(c=>c.ms<=30000);}
        tx.set(rate,{n:(r.data()?.n||0)+1,expiresAt:new Date(Date.now()+7200000)});tx.set(visit,{...next,expiresAt:new Date(Date.now()+90*86400000)});return true;
      });return res.status(accepted?204:429).end();
    }
    if(!path.startsWith('/admin/'))return res.status(404).json({error:'Not found'});
    let token;try{token=await getAuth(tasks).verifyIdToken((req.get('authorization')||'').replace(/^Bearer /,''));}catch{return res.status(401).json({error:'Sign in with your Tasks admin account.'});}
    if(!owner(token))return res.status(403).json({error:'This account is not an owner.'});
    if(path==='/admin/state'&&req.method==='GET'){const s=await configRef.get();return res.json(s.exists?s.data():{...seed,revision:0});}
    if(path==='/admin/links'&&req.method==='PUT'){
      let c;try{c=cleanConfig(req.body);}catch(e){return res.status(400).json({error:e.message});}
      const revision=Number(req.body.revision);const result=await db.runTransaction(async tx=>{
        const s=await tx.get(configRef),old=s.exists?s.data():{...seed,revision:0};
        if(old.revision!==revision)return null;
        const next={...c,revision:revision+1,updatedAt:Date.now()};tx.set(configRef,next);
        tx.set(db.collection('hubAudit').doc(),{at:Date.now(),action:'Homepage published',detail:c.links.filter(l=>!l.hidden).length+' visible links',uid:token.uid});return next;
      });return result?res.json(result):res.status(409).json({error:'The homepage changed in another session. Reload before publishing.'});
    }
    if(path==='/admin/pnc'&&req.method==='GET'){
      const days=Math.min(90,Math.max(1,Number(req.query.days)||30));
      try{const upstream=await fetch('https://pupsnchill.com/api/hub/summary?days='+days,{headers:{Authorization:req.get('authorization')||''},signal:AbortSignal.timeout(18000)});if(!upstream.ok)throw Error();const data=await upstream.json();if(!Number.isFinite(data.website?.total))throw Error();return res.json({...data,connected:true,days});}catch{return res.json({connected:false,error:'Pups N Chill records are temporarily unavailable. Traffic remains available in Analytics.'});}
    }
    if(path==='/admin/forms'&&req.method==='GET'){
      const days=Math.min(90,Math.max(1,Number(req.query.days)||30));
      const outcomes=await Promise.allSettled([nvmSummary(nvmToken.value()),duaSummary(req.get('authorization')||''),db.collection('hubVisits').where('startedAt','>=',Date.now()-days*86400000).orderBy('startedAt','desc').limit(10000).get(),guestRecords(days)]);
      const source=(i)=>outcomes[i].status==='fulfilled'?outcomes[i].value:{connected:false,error:outcomes[i].reason.message};
      const visits=outcomes[2].status==='fulfilled'?outcomes[2].value:null;
      const saved=source(3);
      return res.json({nvm:source(0),dua:source(1),guest:visits?{...guestSummary(visits.docs.map(d=>d.data())),saved,capped:visits.size===10000}:{error:'Guest traffic is temporarily unavailable.',saved},days});
    }
    if(path==='/admin/referrals'&&req.method==='GET'){
      const [s,total]=await Promise.all([db.collection('submissions').orderBy('created_at','desc').limit(10000).get(),db.collection('submissions').count().get()]);
      return res.json(referralReport(s.docs,total.data().count));
    }
    if(path==='/admin/analytics'&&req.method==='GET'){
      const days=Math.min(90,Math.max(1,Number(req.query.days)||30));const since=Date.now()-days*86400000;
      const [s,c]=await Promise.all([db.collection('hubVisits').where('startedAt','>=',since).orderBy('startedAt','desc').limit(10000).get(),configRef.get()]);
      const selected=String(req.query.site||'all');if(selected!=='all'&&!sites.some(x=>x.id===selected))return res.status(400).json({error:'Unknown site'});
      return res.json({...networkReport(s.docs.map(d=>d.data()),c.exists?c.data().links:seed.links,selected),days,capped:s.size===10000,timezone:'America/New_York'});
    }
    if(path==='/admin/activity'&&req.method==='GET'){
      const [sub,audit]=await Promise.all([db.collection('submissions').orderBy('created_at','desc').limit(100).get(),db.collection('hubAudit').orderBy('at','desc').limit(30).get()]);
      return res.json({referrals:sub.docs.map(d=>{const r=d.data();return {id:d.id,business:r.business,name:r.name,email:r.email,createdAt:r.created_at?.toMillis?.()||Date.parse(r.created_at)||0};}),audit:audit.docs.map(d=>({id:d.id,...d.data()}))});
    }
    return res.status(404).json({error:'Not found'});
  }catch(e){console.error('Hub request failed',path,e.code||e.name);return res.status(500).json({error:'Could not complete this request. Please try again.'});}
});

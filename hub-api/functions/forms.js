const NVM_BASE='https://api.airtable.com/v0/apprXW6i8pq4Rnhxw/tblmGGvw7pIveOcAk';
const FIELDS=['Name','Status','Step Name','Last Active','Timestamp'];
function summarizeNvm(records,capped=false){
 const rows=records.map(r=>({id:r.id,name:String(r.fields?.Name||'Unnamed').slice(0,150),status:String(r.fields?.Status||'Unknown').slice(0,40),step:String(r.fields?.['Step Name']||'').slice(0,80),at:Date.parse(r.fields?.['Last Active']||r.createdTime)||0,signedAt:String(r.fields?.Timestamp||'').slice(0,100)})).sort((a,b)=>b.at-a.at);
 return {connected:true,total:rows.length,signed:rows.filter(r=>r.status==='Signed').length,inProgress:rows.filter(r=>r.status==='In Progress').length,capped,rows:rows.slice(0,100),fetchedAt:Date.now()};
}
let nvmCache;
async function nvmSummary(token){
 if(nvmCache&&Date.now()-nvmCache.fetchedAt<60000)return nvmCache;
 if(!token)throw Error('NVM backend connection is not configured.');
 let offset,records=[];
 do{
  const url=new URL(NVM_BASE);FIELDS.forEach(f=>url.searchParams.append('fields[]',f));url.searchParams.set('pageSize','100');if(offset)url.searchParams.set('offset',offset);
  const response=await fetch(url,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error('NVM records are temporarily unavailable.');
  const data=await response.json();if(!Array.isArray(data.records))throw Error('NVM returned an invalid response.');records.push(...data.records);offset=data.offset;
 }while(offset&&records.length<1000);
 nvmCache=summarizeNvm(records,Boolean(offset));return nvmCache;
}
async function duaSummary(token){
 const response=await fetch('https://dua-nda-api.m-938.workers.dev/api/hub/summary',{headers:{Authorization:token},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('Connect the DUA signer backend to load saved signatures.');
 const data=await response.json();if(!Number.isFinite(data.total)||!Number.isFinite(data.signed))throw Error('DUA returned an invalid response.');
 return {...data,connected:true,fetchedAt:Date.now()};
}
function guestSummary(visits){
 const registrations=visits.filter(v=>v.site==='guest-register'||v.page==='/register.html');
 return {views:registrations.length,requestsSent:registrations.filter(v=>(v.clicks||[]).some(c=>c.id==='guest-registration-sent')).length,confirmed:null};
}
module.exports={summarizeNvm,nvmSummary,duaSummary,guestSummary};

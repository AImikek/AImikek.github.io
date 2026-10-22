const {GoogleAuth}=require('google-auth-library');
const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/spreadsheets.readonly']});
const SHEET='1o_TEXEWAZmjwwNvq5d7Do7crHBORv6luW3KqbvkuzEg';
const TAB_ID=1070643329;
let cache;
function summarizeGuestDates(values,days,now=Date.now()){
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const since=new Date(today+'T00:00:00Z').getTime()-(days-1)*86400000;
 const dates=values.map(row=>row[0]).filter(n=>typeof n==='number'&&Number.isFinite(n)&&n>20000&&n<100000).map(n=>(Math.floor(n)-25569)*86400000);
 return {connected:true,total:dates.length,inPeriod:dates.filter(n=>n>=since&&n<=new Date(today+'T00:00:00Z').getTime()).length};
}
async function guestRecords(days){
 try{
  if(!cache||Date.now()-cache.at>60000){
   const client=await auth.getClient();
   const base='https://sheets.googleapis.com/v4/spreadsheets/'+SHEET;
   const meta=await client.request({url:base,params:{fields:'sheets(properties(sheetId,title,gridProperties(rowCount)))'},timeout:8000});
   const sheet=meta.data.sheets.find(s=>s.properties.sheetId===TAB_ID)?.properties;
   if(!sheet)throw Error('Missing response tab');
   const end=Math.min(sheet.gridProperties.rowCount,10001);
   const range="'"+sheet.title.replace(/'/g,"''")+"'!A2:A"+Math.max(2,end);
   const result=await client.request({url:base+'/values/'+encodeURIComponent(range),params:{valueRenderOption:'UNFORMATTED_VALUE',dateTimeRenderOption:'SERIAL_NUMBER'},timeout:8000});
   cache={values:result.data.values||[],at:Date.now(),capped:sheet.gridProperties.rowCount>10001};
  }
  return {...summarizeGuestDates(cache.values,days),fetchedAt:cache.at,capped:cache.capped};
 }catch(error){
  // Never return OAuth details, sheet contents, or provider error bodies.
  console.warn('Guest count connection unavailable:',error.response?.status||error.code||'unknown');
  return {connected:false,error:'Saved guest counts need read access to the response Sheet.'};
 }
}
module.exports={summarizeGuestDates,guestRecords};

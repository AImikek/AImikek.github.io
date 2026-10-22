const test=require('node:test'),assert=require('node:assert/strict');
const {summarizeGuestDates}=require('./guest-records');
test('saved guest totals count timestamp rows and use the selected local calendar window',()=>{
 const serial=s=>Date.parse(s)/86400000+25569;
 const result=summarizeGuestDates([[serial('2026-10-22')+0.7],[serial('2026-10-16')],[serial('2026-10-15')],[],['Timestamp'],['#ERROR!']],7,Date.parse('2026-10-22T20:00:00Z'));
 assert.equal(result.total,3);assert.equal(result.inPeriod,2);
 assert.equal(summarizeGuestDates([],30).total,0);
});

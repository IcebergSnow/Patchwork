export function openStore(dbPath) {
  const slots = [{id:'s1',label:'09:00'},{id:'s2',label:'10:00'},{id:'s3',label:'11:00'}];
  return { listSlots:()=>slots, listBookings:()=>[], book:()=>{throw new Error('TODO persistent booking transaction');}, close:()=>{} };
}

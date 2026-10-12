import {loadSlots, createBooking} from './api.mjs';
const select=document.querySelector('#slot'), message=document.querySelector('#message');
async function refresh(){ select.replaceChildren(...(await loadSlots()).map(s=>new Option(s.label,s.slotId))); }
document.querySelector('#booking-form').addEventListener('submit',async e=>{
  e.preventDefault(); message.textContent='TODO connect booking form';
});
refresh().catch(e=>message.textContent=e.message);

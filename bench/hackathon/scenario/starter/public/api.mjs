export async function loadSlots() { return (await (await fetch('/api/slots')).json()).slots; }
export async function createBooking(slotId, name) { throw new Error('TODO send booking request'); }

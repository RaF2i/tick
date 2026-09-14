const BASE_URL = "https://admin.catedraldesevilla.servitickets.es/api/visits/25";
const TOKEN = "Bearer 1236894|hH3iR17o17C5X3yRXhVkwYdf5qWzn3KTRhD8vrafdf774350";
const Date = "15-09-2026";

const headers = { Authorization: TOKEN };

async function fetchCalendar(month, year) {
  const url = `${BASE_URL}/calendar?place_id=2&tour=25&month=${month}&year=${year}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Calendar API failed: ${res.status}`);
  return (await res.json()).data;
}

async function fetchDayOccupation(date) {
  const url = `${BASE_URL}/calendar/day-occupation?place_id=2&tour=25&date=${date}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Day-occupation API failed: ${res.status}`);
  return (await res.json()).data;
}

function timeOnly(dateStr) {
  return dateStr.replace(/^\d{4}-\d{2}-\d{2}\s*/, "");
}

async function main() {
  // Parse Date "DD-MM-YYYY" → ISO "YYYY-MM-DD"
  const [dd, mm, yyyy] = Date.split("-");
  const isoDate = `${yyyy}-${mm}-${dd}`;
  const month = parseInt(mm, 10);
  const year = parseInt(yyyy, 10);

  console.log(`Fetching calendar for ${month}/${year}...\n`);
  const calendar = await fetchCalendar(month, year);
  const { daysWithItems, closedDays } = calendar;

  // ── Check closed days ──
  const closedMatch = closedDays?.find(cd => cd.date === isoDate);
  if (closedMatch) {
    console.log("=".repeat(70));
    console.log(`  DATE ${Date} IS CLOSED`);
    console.log("=".repeat(70));
    console.log(`  ${closedMatch.date} (Day ${closedMatch.day}) — ${closedMatch.description}`);
    for (const n of closedMatch.notificaciones || []) {
      console.log(`    * ${n.title}`);
      if (n.link) console.log(`      ${n.link}`);
    }
    return;
  }

  // ── Find matching day ──
  const dayInfo = daysWithItems.find(d => d.date === isoDate);
  if (!dayInfo) {
    console.log(`Date ${Date} (${isoDate}) not found in calendar.`);
    return;
  }

  const dateStr = dayInfo.date;
  const tt = dayInfo.timetables || [];

  // Fetch occupation for this day
  let occupation = {};
  try {
    occupation = await fetchDayOccupation(dateStr);
  } catch (err) {
    console.log(`\n  !! ${dateStr}: Could not fetch occupation — ${err.message}`);
  }

  const occEntries = Object.entries(occupation);
  const totalSold = occEntries.reduce((s, [, v]) => s + (v.sold || 0), 0);
  const totalSoldWholesale = occEntries.reduce((s, [, v]) => s + (v.sold_wholesale || 0), 0);
  const totalPending = occEntries.reduce((s, [, v]) => s + (v.pending || 0), 0);
  const totalAvail = occEntries.reduce((s, [, v]) => s + (v.availables || 0), 0);
  const fullyBookedSlots = occEntries.filter(([, v]) => v.is_fully_booked).length;
  const activeSlots = tt.filter(s => s.active).length;
  const ttCapacity = tt.reduce((s, slot) => s + (slot.capacity || 0), 0);

  console.log(`\n${"-".repeat(70)}`);
  console.log(`  DATE: ${dateStr} (Day ${dayInfo.day})`);
  console.log(`${"-".repeat(70)}`);
  console.log(`  Active timetables : ${activeSlots} / ${tt.length}`);
  console.log(`  Timetable capacity: ${ttCapacity} total`);
  console.log(`  Occupation items  : ${occEntries.length}`);
  console.log(`  Total sold        : ${totalSold}  (wholesale: ${totalSoldWholesale})`);
  console.log(`  Total pending     : ${totalPending}`);
  console.log(`  Total available   : ${totalAvail}`);
  if (fullyBookedSlots > 0) {
    console.log(`  !! ${fullyBookedSlots} occupation slot(s) FULLY BOOKED`);
  }

  // ── Combined table ──
  console.log(`\n  SCHEDULE:`);
  console.log(
    `  ${"Start".padEnd(12)} ${"End".padEnd(12)} ${"OccID".padEnd(8)} ${"Sold".padEnd(7)} ${"Cap".padEnd(7)} ${"Avail".padEnd(7)} ${"Full?"}`
  );
  console.log(`  ${"-".repeat(62)}`);

  const occMap = {};
  for (const [id, data] of occEntries) {
    occMap[id] = { id, ...data };
  }
  

  for (let i = 0; i < tt.length; i++) {
    const slot = tt[i];
    const occ = occMap[String(slot.id)] || null;
    const start = timeOnly(slot.start_date);
    const end = timeOnly(slot.end_date);

    if (occ) {
      const full = occ.is_fully_booked ? "FULL" : "open";
      console.log(
        `  ${start.padEnd(12)} ${end.padEnd(12)} ${occ.id.padEnd(8)} ${String(occ.sold).padEnd(7)} ${String(occ.available_capacity).padEnd(7)} ${String(occ.availables).padEnd(7)} ${full}`
      );
    } else {
      console.log(
        `  ${start.padEnd(12)} ${end.padEnd(12)} ${"—".padEnd(8)} ${"—".padEnd(7)} ${"—".padEnd(7)} ${"—".padEnd(7)} —`
      );
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("Done.");
}

main().catch(console.error);

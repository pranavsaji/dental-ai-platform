// Deterministic slot finder (C3). No LLM: candidate slots come straight from
// canonical schedule data — same provider, business hours, first N conflict-
// free openings inside the window. Pure function so it unit-tests without a DB.

export interface BusyInterval {
  startsAt: Date;
  minutes: number;
  operatorySourceId: number;
  providerSourceId: number;
}

export interface SlotQuery {
  providerSourceId: number;
  operatorySourceId: number;
  minutes: number;
  /** Search starts the morning after this instant. */
  from: Date;
  /** Window length in days (like-for-like policy: ≤14 stays auto-approved). */
  days: number;
  count: number;
}

export interface OpenSlot {
  startsAt: Date;
  minutes: number;
  operatorySourceId: number;
  providerSourceId: number;
}

const OPEN_HOUR = 8;
const LAST_START_HOUR = 16; // last bookable start 16:30

function overlaps(aStart: number, aMin: number, bStart: number, bMin: number): boolean {
  return aStart < bStart + bMin * 60_000 && bStart < aStart + aMin * 60_000;
}

export function findOpenSlots(busy: BusyInterval[], q: SlotQuery): OpenSlot[] {
  const relevant = busy.filter(
    (b) => b.operatorySourceId === q.operatorySourceId || b.providerSourceId === q.providerSourceId
  );
  // One offer per day, first opening wins — three offers on three distinct
  // days reads far better in an SMS than three times on the same morning.
  const out: OpenSlot[] = [];
  for (let day = 1; day <= q.days && out.length < q.count; day++) {
    const d = new Date(q.from);
    d.setDate(d.getDate() + day);
    if (d.getDay() === 0 || d.getDay() === 6) continue; // business days only
    daySearch:
    for (let hour = OPEN_HOUR; hour <= LAST_START_HOUR; hour++) {
      for (const minute of [0, 30]) {
        const start = new Date(d);
        start.setHours(hour, minute, 0, 0);
        const t = start.getTime();
        if (relevant.some((b) => overlaps(t, q.minutes, b.startsAt.getTime(), b.minutes))) continue;
        out.push({
          startsAt: start,
          minutes: q.minutes,
          operatorySourceId: q.operatorySourceId,
          providerSourceId: q.providerSourceId
        });
        break daySearch;
      }
    }
  }
  return out;
}

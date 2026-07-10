// In-memory OpenDental-shaped practice store. Rows use the exact PascalCase
// column names of the sim MySQL schema, and every mutation bumps DateTStamp —
// so the edge's MockAdapter can run the same keyset-cursor capture logic (and
// the same transformRow mapping) it uses against real MySQL.

export type Row = Record<string, any>;

export const OD_PK: Record<string, string> = {
  provider: "ProvNum",
  operatory: "OperatoryNum",
  procedurecode: "CodeNum",
  patient: "PatNum",
  appointment: "AptNum",
  procedurelog: "ProcNum",
  insplan: "PlanNum",
  patplan: "PatPlanNum",
  claim: "ClaimNum",
  claimproc: "ClaimProcNum",
  recall: "RecallNum",
  commlog: "CommlogNum",
  payment: "PayNum",
  paysplit: "SplitNum"
};

export function fmtStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export interface StampCursor {
  stamp: string; // "YYYY-MM-DD HH:MM:SS"
  pk: number;
}

export class InMemoryPractice {
  private tables = new Map<string, Map<number, Row>>();
  private counters = new Map<string, number>();
  // Injectable clock so tests can freeze time.
  now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
    for (const table of Object.keys(OD_PK)) this.tables.set(table, new Map());
  }

  table(name: string): Map<number, Row> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`Unknown sim table '${name}'`);
    return t;
  }

  rows(name: string): Row[] {
    return [...this.table(name).values()];
  }

  get(name: string, id: number): Row | undefined {
    return this.table(name).get(id);
  }

  /** Insert with auto-increment PK (or the caller's explicit PK); stamps the row. */
  insert(name: string, row: Row): number {
    const pkCol = OD_PK[name];
    let id: number = row[pkCol];
    if (id == null) {
      id = (this.counters.get(name) ?? this.maxPk(name)) + 1;
      this.counters.set(name, id);
    } else {
      this.counters.set(name, Math.max(this.counters.get(name) ?? 0, id));
    }
    this.table(name).set(id, { ...row, [pkCol]: id, DateTStamp: fmtStamp(this.now()) });
    return id;
  }

  /** Patch a row and bump its DateTStamp (the sim's ON UPDATE CURRENT_TIMESTAMP). */
  update(name: string, id: number, patch: Row): void {
    const existing = this.table(name).get(id);
    if (!existing) throw new Error(`${name} ${id} not found`);
    this.table(name).set(id, { ...existing, ...patch, DateTStamp: fmtStamp(this.now()) });
  }

  /**
   * Keyset scan in (DateTStamp, pk) order past a cursor — the exact contract
   * the MySQL capture query implements, so MockAdapter is a drop-in.
   */
  rowsSince(name: string, cursor: StampCursor, limit: number): Row[] {
    const pkCol = OD_PK[name];
    return this.rows(name)
      .filter((r) =>
        r.DateTStamp > cursor.stamp ||
        (r.DateTStamp === cursor.stamp && Number(r[pkCol]) > cursor.pk))
      .sort((a, b) =>
        a.DateTStamp < b.DateTStamp ? -1 :
        a.DateTStamp > b.DateTStamp ? 1 :
        Number(a[pkCol]) - Number(b[pkCol]))
      .slice(0, limit);
  }

  private maxPk(name: string): number {
    const pkCol = OD_PK[name];
    let max = 0;
    for (const r of this.table(name).values()) max = Math.max(max, Number(r[pkCol]));
    return max;
  }
}

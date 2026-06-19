import type { Pool, PoolClient } from "../pool";

type Queryable = Pool | PoolClient;

export interface CapacityRuleRow {
  weekday: number;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  capacity: number;
}

export interface CapacityOverrideRow {
  date: string; // "YYYY-MM-DD"
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
  capacity: number;
}

export async function loadRules(q: Queryable): Promise<CapacityRuleRow[]> {
  const { rows } = await q.query(
    `SELECT weekday,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time,
            capacity
     FROM capacity_rule`,
  );
  return rows.map((r) => ({
    weekday: r.weekday,
    startTime: r.start_time,
    endTime: r.end_time,
    capacity: r.capacity,
  }));
}

export async function loadOverrides(
  q: Queryable,
  fromDate: string,
  toDate: string,
): Promise<CapacityOverrideRow[]> {
  const { rows } = await q.query(
    `SELECT to_char(date, 'YYYY-MM-DD')    AS date,
            to_char(start_time, 'HH24:MI') AS start_time,
            to_char(end_time,   'HH24:MI') AS end_time,
            capacity
     FROM capacity_override
     WHERE date BETWEEN $1 AND $2`,
    [fromDate, toDate],
  );
  return rows.map((r) => ({
    date: r.date,
    startTime: r.start_time,
    endTime: r.end_time,
    capacity: r.capacity,
  }));
}

import type mysql from "mysql2/promise";
import type { CommandPayload } from "@dental/shared";

// Applies cloud-issued commands to the OpenDental database. Each command runs
// in its own transaction; the returned id is the OpenDental row created or
// affected (e.g. the new AptNum for a booking).

const APT_STATUS_TO_OD: Record<string, number> = {
  scheduled: 1, complete: 2, unscheduled: 3, broken: 5
};

export async function applyCommand(
  conn: mysql.Connection,
  payload: CommandPayload
): Promise<number> {
  await conn.beginTransaction();
  try {
    let resultId: number;
    switch (payload.type) {
      case "BookAppointment": {
        const [res] = await conn.execute<any>(
          `INSERT INTO appointment (PatNum, AptStatus, Pattern, Confirmed, Op, ProvNum, AptDateTime, Note, ProcDescript)
           VALUES (?, 1, ?, 2, ?, ?, ?, ?, ?)`,
          [
            payload.patientSourceId,
            "X".repeat(Math.round(payload.minutes / 5)),
            payload.operatorySourceId,
            payload.providerSourceId,
            payload.startsAt.replace("T", " ").slice(0, 19),
            payload.note,
            payload.procDescript
          ]
        );
        resultId = res.insertId;
        break;
      }
      case "UpdateAppointmentStatus": {
        const [res] = await conn.execute<any>(
          "UPDATE appointment SET AptStatus = ? WHERE AptNum = ?",
          [APT_STATUS_TO_OD[payload.status], payload.appointmentSourceId]
        );
        if (res.affectedRows === 0) throw new Error(`AptNum ${payload.appointmentSourceId} not found`);
        resultId = payload.appointmentSourceId;
        break;
      }
      case "AddCommlog": {
        const [res] = await conn.execute<any>(
          `INSERT INTO commlog (PatNum, CommDateTime, CommType, Note, Mode_, SentOrReceived)
           VALUES (?, NOW(), ?, ?, ?, ?)`,
          [payload.patientSourceId, payload.commType, payload.note, payload.mode, payload.sentOrReceived]
        );
        resultId = res.insertId;
        break;
      }
    }
    await conn.commit();
    return resultId;
  } catch (err) {
    await conn.rollback();
    throw err;
  }
}

import type { AppointmentType } from "../config.ts";

export type { AppointmentType };

/** A bookable 30-minute window. Derived, never persisted as-is. */
export interface Slot {
  start: Date;
  end: Date;
  type: AppointmentType;
}

export type BookingStatus =
  | "held"
  | "confirmed"
  | "patient_confirmed"
  | "cancelled"
  | "done"
  | "expired";

export interface Booking {
  id: string;
  patientName: string | null;
  patientPhone: string;
  appointmentType: AppointmentType;
  start: Date;
  end: Date;
  status: BookingStatus;
  expiresAt: Date | null;
  googleEventId: string | null;
  attendedBy: string | null;
  createdVia: "ai" | "human";
  consentAt: Date | null;
  /** When it was cancelled (by the patient or replaced by a reschedule); null otherwise. 006. */
  cancelledAt: Date | null;
  /** The booking this one replaced through a reschedule; null otherwise. 006. */
  rescheduledFrom: string | null;
  /** When its reminder was queued (007); null = not reminded. */
  reminderSentAt: Date | null;
  /** When reception was told the patient did not answer the reminder (007). */
  unconfirmedNoticeAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A temporary reservation: a booking in its initial `held` state. */
export interface Hold {
  id: string;
  slot: Slot;
  expiresAt: Date;
}

export interface PatientRef {
  phone: string;
}

export interface Patient {
  phone: string;
  name: string;
}

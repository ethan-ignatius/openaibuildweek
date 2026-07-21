import type { TeacherBrainRosterEntry } from "../reasoning/teacher-brain-provider";

export type ClassroomSeatProfile = TeacherBrainRosterEntry & {
  seat: "camera-left" | "camera-right";
};

/**
 * Prototype seating plan. These are teacher-authored profiles, never identities
 * inferred from camera or voice. RTMPose supplies only the fixed camera zone.
 */
export const classroomSeatingPlan: readonly ClassroomSeatProfile[] = [
  {
    seat: "camera-right",
    studentRef: "seat:camera-right",
    name: "Emanuel",
    language: "Spanish",
  },
  {
    seat: "camera-left",
    studentRef: "seat:camera-left",
    name: "Ethan",
    language: "English",
  },
];

export function defaultTeacherBrainRoster(): TeacherBrainRosterEntry[] {
  return classroomSeatingPlan.map(({ studentRef, name, language }) => ({
    studentRef,
    name,
    language,
  }));
}


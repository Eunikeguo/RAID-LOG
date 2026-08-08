/* Cap violations are raised by database triggers, so the UI reads them from
   the error rather than pre-checking counts client-side. OWNER_NOT_ON_PROJECT
   isn't a plan cap, but it's raised the same way, so it lives here too. */
export const CAP_CODES = [
  "PROJECT_LIMIT_REACHED",
  "SEAT_LIMIT_REACHED",
  "PER_PROJECT_LIMIT_REACHED",
  "PROJECT_ADMIN_LIMIT_REACHED",
  "LAST_ADMIN",
  "CSV_EXPORT_REQUIRES_PAID",
  "ALREADY_IN_WORKSPACE",
  "OWNER_NOT_ON_PROJECT",
];

export function capCode(error) {
  if (!error) return null;
  const msg = error.message || String(error);
  return CAP_CODES.find((c) => msg.includes(c)) || null;
}

const FRIENDLY = {
  PROJECT_LIMIT_REACHED: "You've used every project this plan covers.",
  SEAT_LIMIT_REACHED: "Every seat on this plan is taken.",
  PER_PROJECT_LIMIT_REACHED: "That project already holds as many people as the plan allows.",
  PROJECT_ADMIN_LIMIT_REACHED: "That project already has as many admins as the plan allows.",
  LAST_ADMIN: "A workspace needs at least one admin. Promote someone else first.",
  CSV_EXPORT_REQUIRES_PAID: "CSV export comes with the Paid plan.",
  ALREADY_IN_WORKSPACE: "You already belong to a workspace.",
  OWNER_NOT_ON_PROJECT: "That person isn't on this project, so they can't be the owner.",
};

export function friendly(error, fallback = "Something went wrong. Try again.") {
  const code = capCode(error);
  if (code) return FRIENDLY[code];
  return error?.message || fallback;
}

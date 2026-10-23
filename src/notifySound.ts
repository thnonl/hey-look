// The new-mail sound setting (1.0.7 W13.8): one Hey Look! sound with a switch. "pop" = on, "none" = off (what 1.0.6 called Silent).
export type NotifySound = "pop" | "none";

/**
 * A stored value read as the new setting: "none" stays off, every other value is on. 1.0.6 stored mail / default / im / reminder / sms (each one a system sound: all of them become
 * "pop") and none (Silent: stays silent); a value nobody knows is on too (REQ-13.8.1). The backend reads the stored value the same way (notifysound.rs `is_on`).
 */
export const normNotifySound = (v: unknown): NotifySound => (v === "none" ? "none" : "pop");

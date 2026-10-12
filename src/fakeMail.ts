import type { ThreadSummary } from "./api";

// Generated sample mail for previews (Settings > Appearance). Never touches the real mailbox.

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Linh", "Minh", "An", "Hoa", "Sofia", "Daniel", "Aiko", "Mateo", "Priya", "Lucas", "Nora", "Omar", "Elena", "Kenji", "Maya", "Tom"];
const LAST = ["Tran", "Pham", "Nguyen", "Garcia", "Okafor", "Silva", "Tanaka", "Novak", "Patel", "Brown", "Rossi", "Haddad", "Kim", "Lopez"];
const COMPANIES = ["Northwind", "Contoso Travel", "Lumen Bank", "Bluebird Cafe", "Atlas Cloud", "Helio Energy", "Orbit Studio", "Fable Books"];
const BULK = [
  ["Atlas Cloud", "Your weekly usage digest", "Compute hours are up 12% compared with last week. See where the spend went and how to trim it."],
  ["Fable Books", "New this month: 12 releases you may like", "Picked for you based on your reading list. Free shipping on orders over 30."],
  ["Lumen Bank", "Your October statement is ready", "Your statement is available to view securely in the app. No action is needed."],
  ["Orbit Studio", "Product update: dark mode for everyone", "We shipped dark mode, faster search and a redesigned sidebar. Here is what changed."],
];
const SUBJECTS = [
  ["Q{n} roadmap review", "Hi {me}, attaching the latest roadmap deck. Could you look at the milestones before {day}?"],
  ["Lunch {day}?", "{place} at 12:30 works for me. Let me know if you would like to go earlier."],
  ["Invoice #{num} is ready", "Your invoice for {month} is now available. Payment is due in 14 days."],
  ["Re: Contract changes", "Thanks, we updated clause {n}.2 as discussed. Please confirm and we will send it for signature."],
  ["Meeting notes: design sync", "Summary of decisions and the three action items we agreed on, with owners and dates."],
  ["Photos from the offsite", "Sharing the album from last week. Pick your favourites and I will put the best ones in the deck."],
  ["Can you approve the budget?", "The revised budget is attached. We are 4% under the original estimate after the vendor change."],
  ["Quick question about the release", "Do we still plan to ship on {day}? Support would like to prepare the announcement."],
  ["Welcome aboard!", "We are delighted to have you on the team. Here is everything you need for your first week."],
];
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const PLACES = ["Pho", "Ramen", "Tacos", "Salad bar", "Banh mi"];
const MONTHS = ["January", "March", "June", "September", "October", "December"];

export interface FakeMailbox {
  threads: ThreadSummary[];
  message: { from: string; subject: string; paragraphs: string[]; date: number };
}

/** Deterministic for a seed; a different seed gives a different but realistic mailbox. */
export function makeFakeMailbox(seed: number): FakeMailbox {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const now = Math.floor(Date.now() / 1000);
  const fill = (s: string) =>
    s
      .replace("{n}", String(1 + Math.floor(r() * 4)))
      .replace("{num}", String(4000 + Math.floor(r() * 900)))
      .replace("{me}", "Alex")
      .replace("{day}", pick(DAYS))
      .replace("{place}", pick(PLACES))
      .replace("{month}", pick(MONTHS));

  const pool = [...SUBJECTS].sort(() => r() - 0.5);
  const threads: ThreadSummary[] = [];
  let age = 12 + Math.floor(r() * 40); // minutes
  for (let i = 0; i < 7; i++) {
    const bulk = i === 5 || i === 6;
    const [subject, body] = bulk ? [BULK[Math.floor(r() * BULK.length)][1], BULK[Math.floor(r() * BULK.length)][2]] : pool[i % pool.length];
    const who = bulk ? BULK[Math.floor(r() * BULK.length)][0] : `${pick(FIRST)} ${pick(LAST)}`;
    const count = bulk ? 1 : 1 + Math.floor(r() * r() * 5);
    threads.push({
      threadId: `fake-${seed}-${i}`,
      rowKey: `fake-${seed}-${i}`,
      accountId: "fake",
      folder: "inbox",
      subject: fill(subject),
      participants: count > 2 && !bulk ? [who, pick(COMPANIES).split(" ")[0]] : [who],
      snippet: fill(body),
      lastDate: now - age * 60,
      count,
      unread: i < 2 || (!bulk && r() < 0.25) ? 1 : 0,
      flagged: i === 2 || r() < 0.12,
      pinned: i === 0,
      snoozedUntil: null,
      hasAttach: !bulk && r() < 0.35,
      bulk,
    });
    age += i < 2 ? 40 + Math.floor(r() * 90) : 600 + Math.floor(r() * 3000);
  }
  threads.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastDate - a.lastDate);

  const lead = threads.find((t) => !t.bulk) ?? threads[0];
  return {
    threads,
    message: {
      from: lead.participants[0],
      subject: lead.subject,
      date: lead.lastDate,
      paragraphs: [
        `Hi Alex,`,
        lead.snippet,
        pick([
          "Let me know if anything is unclear. Happy to walk through it on a quick call.",
          "No rush on this one, but it would help to have your thoughts by the end of the week.",
          "I have copied the rest of the team so everyone stays in the loop.",
        ]),
        `Thanks,\n${lead.participants[0].split(" ")[0]}`,
      ],
    },
  };
}

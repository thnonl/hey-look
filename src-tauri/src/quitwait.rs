//! The wait of a quit for the page (REQ-48 b, c): how long the backend gives the page to save its draft and let the sends go out, and when
//! it stops waiting. A quit must always finish (QA Linux, v1.0.6: tray "Quit Hey Look!" left the process alive for minutes, with the
//! window hidden in the tray and nobody who could answer a question).
//!
//! Three phases, each with its own bound, and nothing waits for ever:
//! 1. `Sign`: the request went out and the page has not said anything yet. A page that is gone (the web process died, a blank window,
//!    scripts stopped in a hidden window) never will: after `FIRST_SIGN_WAIT` the quit goes on without it.
//! 2. `Work`: the page said it got the request (`Msg::Alive`) and is saving / sending (its sends take 20 s at most, `flushSends`).
//!    After `WORK_WAIT` the quit goes on.
//! 3. `Dialog`: the page asks the person something (a draft that could not be saved) and the window was brought to the front first.
//!    The person gets `DIALOG_WAIT`; then the quit goes on. Nothing is lost by that: the message being written has a local snapshot
//!    (recovery.ts, written every few seconds and when the window is hidden) that is offered at the next start, and a message in its
//!    Undo time is a row of the outbox (`undo=1`) that goes out at the next start (`outbox_startup`).
//!
//! The state machine is pure (it is given the time), so a test drives it with a clock of its own.
//!
//! Several windows (pop-outs, see popout.rs): every window that exists is asked, each with a wait of its own (so the time one person
//! takes for a question does not count against another window), in two steps: first all the secondary windows together (each saves what
//! it holds), then the main window (which saves its inline Compose and lets the sends go out, including those handed over by the
//! secondary ones). Any window whose person chooses to keep writing ends the whole quit: nothing after it is asked, nothing is sent early.
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

/// How long a page that has said nothing at all gets.
pub const FIRST_SIGN_WAIT: Duration = Duration::from_secs(8);
/// How long a page that is working (saving, sending) gets; its own bound for the sends is 20 s.
pub const WORK_WAIT: Duration = Duration::from_secs(45);
/// How long the person gets to answer a question of the page.
pub const DIALOG_WAIT: Duration = Duration::from_secs(60);

/// What the page tells the backend while a quit runs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Msg {
    /// The page got the request and is doing its part.
    Alive,
    /// The page opened (`true`) or closed (`false`) a question to the person.
    Dialog(bool),
    /// The page is done: `true` = go on quitting, `false` = the person chose to keep the window open.
    Answer(bool),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Limits {
    pub first_sign: Duration,
    pub work: Duration,
    pub dialog: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Limits { first_sign: FIRST_SIGN_WAIT, work: WORK_WAIT, dialog: DIALOG_WAIT }
    }
}

/// Why the quit goes on.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Why {
    /// The page was not asked (it never loaded).
    NotAsked,
    /// The page said it is done.
    Answered,
    /// Nobody can answer any more (the channel is closed).
    PageGone,
    /// The page said nothing within `first_sign`.
    NoSign,
    /// The page was working for longer than `work`.
    WorkTooLong,
    /// The person did not answer within `dialog`.
    DialogTooLong,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Verdict {
    Go(Why),
    /// The person chose to keep the window open: the quit is over.
    Stay,
}

impl Verdict {
    /// The line for startup.log.
    pub fn text(&self, limits: &Limits) -> String {
        match self {
            Verdict::Go(Why::NotAsked) => "quit: the page never loaded, nothing to ask".into(),
            Verdict::Go(Why::Answered) => "quit: the page is done (go on: true)".into(),
            Verdict::Go(Why::PageGone) => "quit: the page is gone (no answer can come), quitting".into(),
            Verdict::Go(Why::NoSign) => format!("quit: the page did not answer in {} s, quitting", limits.first_sign.as_secs()),
            Verdict::Go(Why::WorkTooLong) => format!("quit: the page did not finish in {} s, quitting", limits.work.as_secs()),
            Verdict::Go(Why::DialogTooLong) => format!(
                "quit: the question to the person was not answered in {} s, quitting (the message being written is in its recovery snapshot)",
                limits.dialog.as_secs()
            ),
            Verdict::Stay => "quit: the page is done (go on: false), the window stays".into(),
        }
    }
}

/// The order of a quit over several windows: the secondary windows first (together), the main window last. Empty steps are left out.
/// `targets` are window labels; the label of the main window is `main`.
pub fn steps(targets: &[String]) -> Vec<Vec<String>> {
    let secondary: Vec<String> = targets.iter().filter(|l| l.as_str() != "main").cloned().collect();
    let main: Vec<String> = targets.iter().filter(|l| l.as_str() == "main").cloned().collect();
    [secondary, main].into_iter().filter(|s| !s.is_empty()).collect()
}

/// The one verdict of several windows asked together: "stay" as soon as one person chose to keep the window; otherwise "go on", with the
/// reason of the first window that did not simply answer (for the log), or "answered" when every window did.
pub fn merge(verdicts: &[Verdict]) -> Verdict {
    if verdicts.iter().any(|v| *v == Verdict::Stay) {
        return Verdict::Stay;
    }
    let odd = verdicts.iter().find(|v| !matches!(v, Verdict::Go(Why::Answered)));
    odd.copied().unwrap_or(Verdict::Go(Why::Answered))
}

/// Run the steps of a quit: `ask` asks the windows of one step together and returns the verdict of each. Stops after the first step in
/// which a window said "stay": the later steps are not asked. Returns every (window, verdict) in the order asked, and the final verdict
/// ("go on" when no step said stay, and also when there was nothing to ask).
pub fn run_steps(steps: &[Vec<String>], mut ask: impl FnMut(&[String]) -> Vec<(String, Verdict)>) -> (Verdict, Vec<(String, Verdict)>) {
    let mut all = vec![];
    let mut last = Verdict::Go(Why::NotAsked);
    for step in steps {
        let got = ask(step);
        let v = merge(&got.iter().map(|(_, v)| *v).collect::<Vec<_>>());
        all.extend(got);
        if v == Verdict::Stay {
            return (v, all);
        }
        // (a later step that only answered must not hide the reason of an earlier one that did not)
        if matches!(last, Verdict::Go(Why::NotAsked | Why::Answered)) {
            last = v;
        }
    }
    (last, all)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Phase {
    Sign,
    Work,
    Dialog,
}

/// The wait itself. Time is `now`: any monotonic clock, from the moment the page was asked.
#[derive(Debug)]
pub struct Wait {
    limits: Limits,
    phase: Phase,
    since: Duration,
}

impl Wait {
    pub fn new(limits: Limits, now: Duration) -> Self {
        Wait { limits, phase: Phase::Sign, since: now }
    }

    /// The name of the phase, for the log.
    pub fn phase(&self) -> &'static str {
        match self.phase {
            Phase::Sign => "waiting for a first sign of the page",
            Phase::Work => "the page is saving / sending",
            Phase::Dialog => "the page asks the person",
        }
    }

    pub fn on_msg(&mut self, msg: Msg, now: Duration) -> Option<Verdict> {
        match msg {
            Msg::Answer(true) => Some(Verdict::Go(Why::Answered)),
            Msg::Answer(false) => Some(Verdict::Stay),
            Msg::Alive => {
                if self.phase == Phase::Sign {
                    self.phase = Phase::Work;
                    self.since = now;
                }
                None
            }
            Msg::Dialog(true) => {
                self.phase = Phase::Dialog;
                self.since = now;
                None
            }
            Msg::Dialog(false) => {
                // the page goes on (it sends what waits): it gets the working time anew
                if self.phase == Phase::Dialog {
                    self.phase = Phase::Work;
                    self.since = now;
                }
                None
            }
        }
    }

    pub fn on_tick(&self, now: Duration) -> Option<Verdict> {
        let waited = now.saturating_sub(self.since);
        match self.phase {
            Phase::Sign if waited >= self.limits.first_sign => Some(Verdict::Go(Why::NoSign)),
            Phase::Work if waited >= self.limits.work => Some(Verdict::Go(Why::WorkTooLong)),
            Phase::Dialog if waited >= self.limits.dialog => Some(Verdict::Go(Why::DialogTooLong)),
            _ => None,
        }
    }
}

/// Run the wait. `recv` waits at most the given time for a message of the page (`rx.recv_timeout`); `now` is the clock; `on_msg` sees
/// every message (the backend brings the window to the front for a question). Returns when the quit goes on or is over.
pub fn drive(
    mut recv: impl FnMut(Duration) -> Result<Msg, RecvTimeoutError>,
    now: impl Fn() -> Duration,
    limits: Limits,
    tick: Duration,
    mut on_msg: impl FnMut(Msg, &str),
) -> Verdict {
    let mut wait = Wait::new(limits, now());
    loop {
        let verdict = match recv(tick) {
            Ok(msg) => {
                let v = wait.on_msg(msg, now());
                on_msg(msg, wait.phase());
                v
            }
            Err(RecvTimeoutError::Timeout) => wait.on_tick(now()),
            Err(RecvTimeoutError::Disconnected) => Some(Verdict::Go(Why::PageGone)),
        };
        if let Some(v) = verdict {
            return v;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;

    fn s(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// A page that never answers: the quit goes on after the first-sign time, not after the working time.
    #[test]
    fn a_page_that_says_nothing_is_given_up_after_the_first_sign_time() {
        let w = Wait::new(Limits::default(), s(100));
        assert_eq!(w.on_tick(s(100) + FIRST_SIGN_WAIT - Duration::from_millis(1)), None);
        assert_eq!(w.on_tick(s(100) + FIRST_SIGN_WAIT), Some(Verdict::Go(Why::NoSign)));
    }

    #[test]
    fn a_page_that_is_working_gets_the_working_time_from_its_sign() {
        let mut w = Wait::new(Limits::default(), s(0));
        assert_eq!(w.on_msg(Msg::Alive, s(3)), None);
        assert_eq!(w.on_tick(s(3) + s(30)), None, "past the first-sign time, but the page is working");
        assert_eq!(w.on_tick(s(3) + WORK_WAIT), Some(Verdict::Go(Why::WorkTooLong)));
        // a second sign changes nothing
        assert_eq!(w.on_msg(Msg::Alive, s(40)), None);
        assert_eq!(w.on_tick(s(3) + WORK_WAIT), Some(Verdict::Go(Why::WorkTooLong)));
    }

    #[test]
    fn a_question_to_the_person_is_bounded_too() {
        let mut w = Wait::new(Limits::default(), s(0));
        w.on_msg(Msg::Alive, s(1));
        assert_eq!(w.on_msg(Msg::Dialog(true), s(2)), None);
        assert_eq!(w.on_tick(s(2) + WORK_WAIT + s(10)), None, "the question has its own, longer time than the working time");
        assert_eq!(w.on_tick(s(2) + DIALOG_WAIT), Some(Verdict::Go(Why::DialogTooLong)));
        // a question that opens without a sign before it (the sign got lost) counts as a sign
        let mut w = Wait::new(Limits::default(), s(0));
        assert_eq!(w.on_msg(Msg::Dialog(true), s(5)), None);
        assert_eq!(w.on_tick(s(9)), None, "no longer the first-sign time");
        assert_eq!(w.on_tick(s(5) + DIALOG_WAIT), Some(Verdict::Go(Why::DialogTooLong)));
    }

    #[test]
    fn closing_the_question_gives_the_page_its_working_time_anew() {
        let mut w = Wait::new(Limits::default(), s(0));
        w.on_msg(Msg::Dialog(true), s(1));
        assert_eq!(w.on_msg(Msg::Dialog(false), s(50)), None);
        assert_eq!(w.on_tick(s(50) + WORK_WAIT - Duration::from_millis(1)), None);
        assert_eq!(w.on_tick(s(50) + WORK_WAIT), Some(Verdict::Go(Why::WorkTooLong)));
        // a "closed" without a question before it changes nothing
        let mut w = Wait::new(Limits::default(), s(0));
        assert_eq!(w.on_msg(Msg::Dialog(false), s(2)), None);
        assert_eq!(w.on_tick(FIRST_SIGN_WAIT), Some(Verdict::Go(Why::NoSign)));
    }

    #[test]
    fn the_answer_decides_in_every_phase() {
        for before in [vec![], vec![Msg::Alive], vec![Msg::Alive, Msg::Dialog(true)]] {
            for (go, want) in [(true, Verdict::Go(Why::Answered)), (false, Verdict::Stay)] {
                let mut w = Wait::new(Limits::default(), s(0));
                for m in &before {
                    w.on_msg(*m, s(1));
                }
                assert_eq!(w.on_msg(Msg::Answer(go), s(2)), Some(want));
            }
        }
    }

    /// The driver with a fake page and a fake clock: every `recv` consumes the page's script, then lets the (fake) time pass.
    fn run(script: Vec<(u64, Msg)>, limits: Limits) -> (Verdict, u64, Vec<String>) {
        let clock = Cell::new(Duration::ZERO);
        let mut script: VecDeque<(u64, Msg)> = script.into();
        let seen = std::cell::RefCell::new(vec![]);
        let tick = Duration::from_millis(200);
        let v = drive(
            |t| {
                // the next message arrives if it is due within this tick
                match script.front() {
                    Some(&(at, msg)) if Duration::from_millis(at) <= clock.get() + t => {
                        script.pop_front();
                        clock.set(Duration::from_millis(at).max(clock.get()));
                        Ok(msg)
                    }
                    _ => {
                        clock.set(clock.get() + t);
                        Err(RecvTimeoutError::Timeout)
                    }
                }
            },
            || clock.get(),
            limits,
            tick,
            |m, phase| seen.borrow_mut().push(format!("{m:?}: {phase}")),
        );
        (v, clock.get().as_millis() as u64, seen.into_inner())
    }

    #[test]
    fn a_page_that_never_answers_ends_the_quit_at_the_first_sign_time() {
        let (v, at, _) = run(vec![], Limits::default());
        assert_eq!(v, Verdict::Go(Why::NoSign));
        assert!((8000..8300).contains(&at), "at {at} ms");
        assert_eq!(v.text(&Limits::default()), "quit: the page did not answer in 8 s, quitting");
    }

    #[test]
    fn a_page_that_answers_late_but_within_its_time_is_waited_for() {
        let (v, at, seen) = run(vec![(500, Msg::Alive), (19_000, Msg::Answer(true))], Limits::default());
        assert_eq!(v, Verdict::Go(Why::Answered));
        assert_eq!(at, 19_000);
        assert_eq!(seen.len(), 2);
        // it said it works, then it hangs: the working time ends it
        let (v, at, _) = run(vec![(500, Msg::Alive)], Limits::default());
        assert_eq!(v, Verdict::Go(Why::WorkTooLong));
        assert!((45_500..45_800).contains(&at), "at {at} ms");
    }

    #[test]
    fn a_page_that_asks_a_question_waits_for_the_person_and_not_for_ever() {
        // the person answers after 40 s: longer than the working time, shorter than the question's time
        let (v, _, seen) = run(vec![(300, Msg::Alive), (1000, Msg::Dialog(true)), (41_000, Msg::Dialog(false)), (41_100, Msg::Answer(false))], Limits::default());
        assert_eq!(v, Verdict::Stay);
        assert!(seen[1].contains("asks the person"), "{seen:?}");
        // nobody answers (the window is hidden or blank)
        let (v, at, _) = run(vec![(300, Msg::Alive), (1000, Msg::Dialog(true))], Limits::default());
        assert_eq!(v, Verdict::Go(Why::DialogTooLong));
        assert!((61_000..61_300).contains(&at), "at {at} ms");
        assert!(v.text(&Limits::default()).contains("not answered in 60 s"));
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_secondary_windows_are_asked_before_the_main_window() {
        assert_eq!(steps(&names(&["main", "compose-1", "reader-2"])), vec![names(&["compose-1", "reader-2"]), names(&["main"])]);
        assert_eq!(steps(&names(&["compose-1"])), vec![names(&["compose-1"])]);
        assert_eq!(steps(&names(&["main"])), vec![names(&["main"])]);
        assert!(steps(&[]).is_empty(), "no window, no step");
    }

    #[test]
    fn any_window_that_keeps_its_message_stops_the_quit() {
        let go = Verdict::Go(Why::Answered);
        assert_eq!(merge(&[]), go);
        assert_eq!(merge(&[go, go]), go);
        assert_eq!(merge(&[go, Verdict::Stay, go]), Verdict::Stay);
        assert_eq!(merge(&[Verdict::Go(Why::NoSign), Verdict::Stay]), Verdict::Stay, "a window that said nothing does not hide another's no");
        assert_eq!(merge(&[go, Verdict::Go(Why::NoSign), Verdict::Go(Why::WorkTooLong)]), Verdict::Go(Why::NoSign), "go on, with the first odd reason");
    }

    /// A fake window system: every window is a script run with its own clock (as the real ones are, on threads of their own).
    fn windows(scripts: Vec<(&'static str, Vec<(u64, Msg)>)>) -> impl FnMut(&[String]) -> Vec<(String, Verdict)> {
        move |labels: &[String]| {
            labels
                .iter()
                .map(|l| {
                    let script = scripts.iter().find(|(n, _)| n == l).map(|(_, s)| s.clone()).unwrap_or_default();
                    (l.clone(), run(script, Limits::default()).0)
                })
                .collect()
        }
    }

    #[test]
    fn a_quit_over_many_windows_asks_each_with_a_wait_of_its_own() {
        let all = names(&["main", "compose-1", "compose-2", "reader-3"]);
        // everybody answers "go on"; one asks a question for 50 s first (longer than the 45 s of the working time), another is silent
        let ask = windows(vec![
            ("compose-1", vec![(300, Msg::Alive), (1000, Msg::Dialog(true)), (51_000, Msg::Dialog(false)), (51_100, Msg::Answer(true))]),
            ("compose-2", vec![]),
            ("reader-3", vec![(100, Msg::Answer(true))]),
            ("main", vec![(100, Msg::Alive), (500, Msg::Answer(true))]),
        ]);
        let (v, all_v) = run_steps(&steps(&all), ask);
        assert_eq!(v, Verdict::Go(Why::NoSign), "the silent window is given up after 8 s and the quit goes on; the reason is the first odd one");
        let by = |l: &str| all_v.iter().find(|(n, _)| n == l).unwrap().1;
        assert_eq!(by("compose-1"), Verdict::Go(Why::Answered), "its question took longer than the working time and was not cut off");
        assert_eq!(by("compose-2"), Verdict::Go(Why::NoSign));
        assert_eq!(by("main"), Verdict::Go(Why::Answered));
        assert_eq!(all_v.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>().last(), Some(&"main"), "main is asked last");
    }

    #[test]
    fn a_no_from_a_secondary_window_ends_the_quit_before_main_is_asked() {
        let all = names(&["main", "compose-1", "compose-2"]);
        let mut asked: Vec<Vec<String>> = vec![];
        let mut inner = windows(vec![("compose-1", vec![(100, Msg::Answer(true))]), ("compose-2", vec![(200, Msg::Alive), (300, Msg::Answer(false))]), ("main", vec![(100, Msg::Answer(true))])]);
        let (v, got) = run_steps(&steps(&all), |l| {
            asked.push(l.to_vec());
            inner(l)
        });
        assert_eq!(v, Verdict::Stay);
        assert_eq!(asked, vec![names(&["compose-1", "compose-2"])], "main was not asked: nothing is sent early");
        assert_eq!(got.len(), 2);
        // a no from main ends it too
        let (v, _) = run_steps(&steps(&all), windows(vec![("compose-1", vec![(100, Msg::Answer(true))]), ("compose-2", vec![(100, Msg::Answer(true))]), ("main", vec![(100, Msg::Answer(false))])]));
        assert_eq!(v, Verdict::Stay);
    }

    #[test]
    fn nothing_to_ask_is_not_a_reason_to_wait() {
        let (v, got) = run_steps(&[], |_| panic!("nobody to ask"));
        assert_eq!((v, got.len()), (Verdict::Go(Why::NotAsked), 0));
        let (v, _) = run_steps(&steps(&names(&["main"])), windows(vec![("main", vec![(10, Msg::Answer(true))])]));
        assert_eq!(v, Verdict::Go(Why::Answered));
    }

    /// The same with a real channel and a page on a thread, with short limits.
    #[test]
    fn the_real_channel_works_like_the_fake_one() {
        use std::sync::mpsc::channel;
        let limits = Limits { first_sign: Duration::from_millis(300), work: Duration::from_millis(600), dialog: Duration::from_millis(900) };
        let drive_with = |script: Vec<(u64, Msg)>, keep_sender: bool| {
            let (tx, rx) = channel::<Msg>();
            let t0 = std::time::Instant::now();
            let page = std::thread::spawn(move || {
                for (at, m) in script {
                    std::thread::sleep(Duration::from_millis(at).saturating_sub(t0.elapsed()));
                    let _ = tx.send(m);
                }
                if keep_sender {
                    std::thread::sleep(Duration::from_secs(3)); // a page that hangs: the sender stays alive
                }
            });
            let v = drive(|t| rx.recv_timeout(t), || t0.elapsed(), limits, Duration::from_millis(20), |_, _| {});
            let took = t0.elapsed();
            if !keep_sender {
                page.join().unwrap();
            }
            (v, took)
        };
        let (v, took) = drive_with(vec![], true);
        assert_eq!((v, took < Duration::from_secs(2)), (Verdict::Go(Why::NoSign), true));
        let (v, _) = drive_with(vec![(50, Msg::Alive), (150, Msg::Answer(true))], true);
        assert_eq!(v, Verdict::Go(Why::Answered));
        let (v, took) = drive_with(vec![(50, Msg::Dialog(true))], true);
        assert_eq!(v, Verdict::Go(Why::DialogTooLong));
        assert!(took >= Duration::from_millis(900) && took < Duration::from_secs(2), "{took:?}");
        // the page's end of the channel is dropped: nobody can answer
        let (v, _) = drive_with(vec![(50, Msg::Alive)], false);
        assert_eq!(v, Verdict::Go(Why::PageGone));
    }
}

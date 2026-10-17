//! A window whose page never comes up: what the person is told, and what they can do about it.
//!
//! Until 1.0.5 the app only wrote "giving up: the page never reported itself" to `startup.log` after its reloads (`startup::watch`)
//! and left a blank window. The page is the thing that does not work, so the message cannot be a page: it is a native message box
//! (the dialog plugin), with its texts from `i18n` (the Rust side, in the language the UI last mirrored), saying that the app could
//! not load its interface and why that usually is (the web engine of the system: WebView2 on Windows, WebKit on macOS, WebKitGTK on
//! Linux), with three answers: **Retry**, **Open log folder** (reveals `startup.log`) and **Quit**.
//!
//! This file is the state machine, pure so a test can run it with a fake clock; `startup.rs` supplies the real hooks. The rules:
//! * `startup::watch` makes its tries first (the reloads of before); only when the last one failed does the person hear of it;
//! * the error is shown **once per failed round** (also after "Open log folder": the same dialog comes back, no second line about it);
//! * a page that answers late cancels everything: before the dialog is shown (nothing is shown at all), and after "Retry" (nothing is
//!   reloaded); a native message box that is already open cannot be withdrawn from outside, so its answers are then ignored;
//! * a window that is hidden (started to the tray) is not covered with a dialog: the error waits until the window is shown;
//! * "Retry" starts a new round of the same tries; "Quit" ends the app (the dialog's close button counts as Quit).
use crate::startup::{watch, Event};
use std::time::Duration;

/// How often a hidden window is looked at while the error waits for it to be shown.
pub const HIDDEN_TICK: Duration = Duration::from_millis(500);

/// The person's answer.
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Answer {
    Retry,
    OpenLog,
    Quit,
}

/// What `drive` reports, in order; the caller does the work that belongs to each (and logs it).
#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Ev {
    /// An event of the wait loop (`startup::watch`): ready, or no signal (with a reload to follow, or not).
    Watch(Event),
    /// Every try failed but the window is hidden: the error waits until it is shown.
    Waiting,
    /// The error is on screen. Once per failed round.
    ErrorShown { round: u32 },
    /// "Open log folder" (the dialog comes back).
    OpenedLog,
    /// "Retry": load the page again (`round` is the number of the round that starts).
    Retrying { round: u32 },
    /// The page answered after the tries, or while the error was open: nothing is shown / nothing is reloaded.
    LateAnswer,
    /// "Quit".
    Quitting,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Done {
    /// The page is up.
    Ready,
    /// The person chose to quit.
    Quit,
}

/// Run the guard until the page is up or the person quits.
///
/// * `first_watch`: start with the wait loop (the window was just created); false = the page is already known to be gone, go
///   straight to the error (`startup::report_dead_page`).
/// * `ready`: the page is up. `visible`: the window is shown. `sleep`: the clock. `ask`: show the error, return the answer.
pub fn drive(
    first_watch: bool,
    ready: impl Fn() -> bool,
    visible: impl Fn() -> bool,
    mut sleep: impl FnMut(Duration),
    mut ask: impl FnMut(u32) -> Answer,
    mut on: impl FnMut(Ev),
) -> Done {
    let mut round = 0u32;
    let mut watch_first = first_watch;
    loop {
        if watch_first {
            let mut failed = false;
            watch(&ready, &mut sleep, |e| {
                failed |= matches!(e, Event::NoSignal { will_reload: false, .. });
                on(Ev::Watch(e));
            });
            if !failed {
                return Done::Ready;
            }
        }
        watch_first = true;
        // told only in a window the person can see; a page that comes up meanwhile cancels the error
        let mut waiting = false;
        while !visible() {
            if ready() {
                on(Ev::LateAnswer);
                return Done::Ready;
            }
            if !waiting {
                waiting = true;
                on(Ev::Waiting);
            }
            sleep(HIDDEN_TICK);
        }
        if ready() {
            on(Ev::LateAnswer);
            return Done::Ready;
        }
        on(Ev::ErrorShown { round });
        loop {
            let answer = ask(round);
            // the page may have answered while the dialog was open: Retry would reload a page that works
            if ready() && answer != Answer::Quit {
                on(Ev::LateAnswer);
                return Done::Ready;
            }
            match answer {
                Answer::OpenLog => on(Ev::OpenedLog),
                Answer::Retry => {
                    round += 1;
                    on(Ev::Retrying { round });
                    break;
                }
                Answer::Quit => {
                    on(Ev::Quitting);
                    return Done::Quit;
                }
            }
        }
    }
}

/// The dialog's answer from the label of the button that was pressed (rfd and the dialog plugin hand back the custom label; the
/// plain Yes / No / Cancel / Ok mean the same buttons in the same order; anything else, the close button included, is Quit).
pub fn answer_from(label: &str, retry: &str, open_log: &str, quit: &str) -> Answer {
    match label {
        l if l == retry || l == "Yes" || l == "Ok" => Answer::Retry,
        l if l == open_log || l == "No" => Answer::OpenLog,
        l if l == quit => Answer::Quit,
        _ => Answer::Quit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    /// One run with a fake clock. `ready_at`: the tick (50 ms each, 360 per round of three tries) from which the page answers.
    /// `visible_from`: the tick from which the window is shown. `answers`: the person's answers in order; running out = Quit.
    struct Run {
        events: Vec<Ev>,
        asked: u32,
        done: Done,
        ticks: u64,
    }

    fn run(first_watch: bool, ready_at: Option<u64>, visible_from: u64, answers: &[Answer], ready_while_asking: bool) -> Run {
        let ticks = Cell::new(0u64);
        let asked = Cell::new(0u32);
        let events = RefCell::new(vec![]);
        let mut script = answers.iter().copied();
        let page_up = Cell::new(false);
        let done = drive(
            first_watch,
            || page_up.get() || ready_at.is_some_and(|n| ticks.get() >= n),
            || ticks.get() >= visible_from,
            |d| ticks.set(ticks.get() + (d.as_millis() as u64 / 50)),
            |_| {
                asked.set(asked.get() + 1);
                if ready_while_asking {
                    page_up.set(true);
                }
                script.next().unwrap_or(Answer::Quit)
            },
            |e| events.borrow_mut().push(e),
        );
        Run { events: events.into_inner(), asked: asked.get(), done, ticks: ticks.get() }
    }

    const ROUND: u64 = 3 * (crate::startup::READY_WAIT.as_millis() as u64 / 50);

    fn watch_failed(first: bool) -> Vec<Ev> {
        let mut v = vec![];
        if first {
            v.push(Ev::Watch(Event::NoSignal { attempt: 0, will_reload: true }));
            v.push(Ev::Watch(Event::NoSignal { attempt: 1, will_reload: true }));
            v.push(Ev::Watch(Event::NoSignal { attempt: 2, will_reload: false }));
        }
        v
    }

    fn shown(events: &[Ev]) -> usize {
        events.iter().filter(|e| matches!(e, Ev::ErrorShown { .. })).count()
    }

    #[test]
    fn a_page_that_comes_up_in_time_never_sees_an_error() {
        let r = run(true, Some(10), 0, &[], false);
        assert_eq!(r.done, Done::Ready);
        assert_eq!(r.events, vec![Ev::Watch(Event::Ready { waited_ms: 500 })]);
        assert_eq!(r.asked, 0);
    }

    #[test]
    fn three_tries_then_the_error_once_then_quit_ends_it() {
        let r = run(true, None, 0, &[Answer::Quit], false);
        let mut want = watch_failed(true);
        want.extend([Ev::ErrorShown { round: 0 }, Ev::Quitting]);
        assert_eq!(r.events, want);
        assert_eq!((r.done, r.asked, shown(&r.events)), (Done::Quit, 1, 1));
        assert_eq!(r.ticks, ROUND, "the error comes when the third try has run out, not before");
    }

    #[test]
    fn retry_starts_a_new_round_and_a_page_that_comes_then_ends_it_with_no_second_error() {
        // the page answers 100 ticks into the second round
        let r = run(true, Some(ROUND + 100), 0, &[Answer::Retry], false);
        let mut want = watch_failed(true);
        want.extend([Ev::ErrorShown { round: 0 }, Ev::Retrying { round: 1 }, Ev::Watch(Event::Ready { waited_ms: 5000 })]);
        assert_eq!(r.events, want, "{:?}", r.events);
        assert_eq!((r.done, r.asked, shown(&r.events)), (Done::Ready, 1, 1));
    }

    #[test]
    fn a_retry_that_fails_again_shows_the_error_again_once_per_round() {
        let r = run(true, None, 0, &[Answer::Retry, Answer::Retry, Answer::Quit], false);
        assert_eq!(shown(&r.events), 3, "{:?}", r.events);
        let rounds: Vec<u32> = r.events.iter().filter_map(|e| if let Ev::ErrorShown { round } = e { Some(*round) } else { None }).collect();
        assert_eq!(rounds, [0, 1, 2]);
        assert_eq!(r.events.iter().filter(|e| matches!(e, Ev::Retrying { .. })).count(), 2);
        assert_eq!((r.done, r.asked), (Done::Quit, 3));
        assert_eq!(r.ticks, 3 * ROUND, "each round makes its three tries again");
    }

    #[test]
    fn open_log_folder_brings_the_same_dialog_back_without_a_second_error() {
        let r = run(true, None, 0, &[Answer::OpenLog, Answer::OpenLog, Answer::Quit], false);
        assert_eq!(shown(&r.events), 1, "one error, however often the folder is opened: {:?}", r.events);
        assert_eq!(r.events.iter().filter(|e| matches!(e, Ev::OpenedLog)).count(), 2);
        assert_eq!((r.done, r.asked), (Done::Quit, 3));
        assert_eq!(r.ticks, ROUND, "no wait of its own");
    }

    #[test]
    fn a_page_that_answers_after_the_tries_but_before_the_error_cancels_it() {
        // hidden (tray start) until tick 2000; the page is up at tick 1500, long after the last try: nothing is shown ever
        let r = run(true, Some(1500), 2000, &[Answer::Quit], false);
        let mut want = watch_failed(true);
        want.extend([Ev::Waiting, Ev::LateAnswer]);
        assert_eq!(r.events, want, "{:?}", r.events);
        assert_eq!((r.done, r.asked), (Done::Ready, 0));
        // and one that is up the very moment the tries end
        let r = run(true, Some(ROUND), 0, &[Answer::Quit], false);
        assert_eq!((r.done, r.asked, shown(&r.events)), (Done::Ready, 0, 0), "{:?}", r.events);
        assert!(r.events.contains(&Ev::LateAnswer));
    }

    #[test]
    fn a_page_that_answers_while_the_dialog_is_open_is_not_reloaded_by_retry() {
        for answer in [Answer::Retry, Answer::OpenLog] {
            let r = run(true, None, 0, &[answer], true);
            assert_eq!(r.done, Done::Ready, "{answer:?}");
            assert!(r.events.contains(&Ev::LateAnswer), "{:?}", r.events);
            assert!(!r.events.iter().any(|e| matches!(e, Ev::Retrying { .. } | Ev::OpenedLog)), "{answer:?}: {:?}", r.events);
            assert_eq!((r.asked, shown(&r.events)), (1, 1));
        }
        // Quit is still a Quit: the person chose it
        let r = run(true, None, 0, &[Answer::Quit], true);
        assert_eq!(r.done, Done::Quit);
    }

    #[test]
    fn a_hidden_window_gets_the_error_only_when_it_is_shown() {
        let r = run(true, None, ROUND + 400, &[Answer::Quit], false);
        let mut want = watch_failed(true);
        want.extend([Ev::Waiting, Ev::ErrorShown { round: 0 }, Ev::Quitting]);
        assert_eq!(r.events, want, "{:?}", r.events);
        assert_eq!(r.ticks, ROUND + 400);
        assert_eq!(r.events.iter().filter(|e| **e == Ev::Waiting).count(), 1, "said once, not every half second");
    }

    #[test]
    fn a_page_known_to_be_gone_goes_straight_to_the_error() {
        // the end states of webview_health (restart refused, nothing brought the page back): no tries to make
        let r = run(false, None, 0, &[Answer::Retry, Answer::Quit], false);
        assert_eq!(r.events[0], Ev::ErrorShown { round: 0 }, "{:?}", r.events);
        assert_eq!((r.done, r.asked), (Done::Quit, 2));
        // after its Retry the round does wait for the page, three tries long
        assert!(r.events.iter().any(|e| matches!(e, Ev::Watch(Event::NoSignal { attempt: 2, will_reload: false }))), "{:?}", r.events);
    }

    #[test]
    fn the_answer_is_read_back_from_the_button_label() {
        let (r, o, q) = ("Retry", "Open log folder", "Quit");
        assert_eq!(answer_from("Retry", r, o, q), Answer::Retry);
        assert_eq!(answer_from("Open log folder", r, o, q), Answer::OpenLog);
        assert_eq!(answer_from("Quit", r, o, q), Answer::Quit);
        // the plain results of a dialog that took no custom labels, and the close button
        assert_eq!(answer_from("Yes", r, o, q), Answer::Retry);
        assert_eq!(answer_from("No", r, o, q), Answer::OpenLog);
        assert_eq!(answer_from("Cancel", r, o, q), Answer::Quit);
        assert_eq!(answer_from("", r, o, q), Answer::Quit);
        // another language
        assert_eq!(answer_from("Réessayer", "Réessayer", "Ouvrir le dossier des journaux", "Quitter"), Answer::Retry);
    }
}

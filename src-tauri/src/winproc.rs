//! The one place that starts other programs. On Windows a child process of a GUI program opens a console window (a black box that
//! flashes) unless it is created with CREATE_NO_WINDOW, so every spawn goes through `hidden` (a test below fails when another
//! file calls `Command::new` outside tests).
use std::process::Command;

/// `Command::new(program)`, without a console window on Windows.
pub fn hidden(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_starts_a_program_and_reports_its_exit() {
        #[cfg(windows)]
        let out = super::hidden("cmd").args(["/C", "exit 3"]).output().unwrap();
        #[cfg(not(windows))]
        let out = super::hidden("sh").args(["-c", "exit 3"]).output().unwrap();
        assert_eq!(out.status.code(), Some(3));
    }

    /// No file but this one starts a process directly: the app code (outside `#[cfg(test)]` modules) must use `hidden`.
    #[test]
    fn nobody_else_spawns_a_process() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = vec![];
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") || path.file_name().and_then(|n| n.to_str()) == Some("winproc.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            // only the code before the first test module counts
            let code = crate::test_guard::non_test_code(&text);
            for (n, line) in code.lines().enumerate() {
                let t = line.trim_start();
                if t.starts_with("//") {
                    continue;
                }
                if t.contains("Command::new(") {
                    offenders.push(format!("{}:{}: {}", path.file_name().unwrap().to_string_lossy(), n + 1, t));
                }
            }
        }
        assert!(offenders.is_empty(), "start programs with winproc::hidden (no console window on Windows):\n{}", offenders.join("\n"));
    }
}

//! Host command runner: the thing that makes a key able to run git/shell.
//!
//! Flow: key on the board sends a Raw HID RunHostCmd packet -> the app looks up
//! the HostBinding for that index -> runs it here. This is the piece Vial cannot
//! do (a keyboard can only type, not execute).
//!
//! SAFETY: only ever runs bindings the user configured in the app. The board
//! sends an *index*, never a command string, so a compromised board can at worst
//! trigger an already-approved binding, not inject an arbitrary command.

use crate::model::HostBinding;
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("no binding for index {0}")]
    NoBinding(u8),
    #[error("empty command")]
    Empty,
    #[error("spawn failed: {0}")]
    Spawn(String),
}

pub struct RunOutcome {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

pub fn run_binding(bindings: &[HostBinding], index: u8) -> Result<RunOutcome, RunError> {
    let b = bindings
        .iter()
        .find(|b| b.index == index)
        .ok_or(RunError::NoBinding(index))?;
    // A script goes through a shell; a command list is spawned directly.
    //
    // Both come from bindings the user authored in this app — the board only
    // ever sends an index, so this cannot be steered from the keyboard side.
    let mut cmd = match b.script.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(script) => {
            #[cfg(windows)]
            {
                let mut c = Command::new("powershell");
                c.args(["-NoProfile", "-NonInteractive", "-Command", script]);
                c
            }
            #[cfg(not(windows))]
            {
                let mut c = Command::new("sh");
                c.args(["-c", script]);
                c
            }
        }
        None => {
            let (program, args) = b.command.split_first().ok_or(RunError::Empty)?;
            let mut c = Command::new(program);
            c.args(args);
            c
        }
    };
    if let Some(cwd) = &b.cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().map_err(|e| RunError::Spawn(e.to_string()))?;
    Ok(RunOutcome {
        status: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo_binding() -> HostBinding {
        // Windows: `echo` is a shell built-in, not an executable — delegate to cmd.
        #[cfg(target_os = "windows")]
        let command = vec!["cmd".into(), "/C".into(), "echo".into(), "hello".into()];
        #[cfg(not(target_os = "windows"))]
        let command = vec!["echo".into(), "hello".into()];
        HostBinding { index: 0, label: "echo test".into(), command, script: None, cwd: None }
    }

    /// A script runs through a shell, so it can use constructs a directly
    /// spawned process cannot — here, two statements in one binding.
    #[test]
    fn runs_a_shell_script_binding() {
        let bindings = vec![HostBinding {
            index: 3,
            label: "script".into(),
            command: vec![],
            script: Some("echo one\necho two".into()),
            cwd: None,
        }];
        let out = run_binding(&bindings, 3).expect("script should run");
        assert!(out.stdout.contains("one"), "stdout was {:?}", out.stdout);
        assert!(out.stdout.contains("two"), "stdout was {:?}", out.stdout);
    }

    /// A script wins over `command`, so a binding converted from one to the
    /// other cannot silently keep running the old thing.
    #[test]
    fn script_takes_precedence_over_command() {
        let mut b = echo_binding();
        b.script = Some("echo scripted".into());
        let out = run_binding(&[b], 0).unwrap();
        assert!(out.stdout.contains("scripted"), "stdout was {:?}", out.stdout);
        assert!(!out.stdout.contains("hello"));
    }

    #[test]
    fn runs_a_bound_command() {
        let bindings = vec![echo_binding()];
        let out = run_binding(&bindings, 0).unwrap();
        assert_eq!(out.status, Some(0));
        assert!(out.stdout.contains("hello"));
    }

    #[test]
    fn unknown_index_errors() {
        let bindings = vec![echo_binding()];
        assert!(matches!(run_binding(&bindings, 9), Err(RunError::NoBinding(9))));
    }
}

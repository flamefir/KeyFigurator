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
    let (program, args) = b.command.split_first().ok_or(RunError::Empty)?;
    let mut cmd = Command::new(program);
    cmd.args(args);
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
        HostBinding { index: 0, label: "echo test".into(), command, cwd: None }
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

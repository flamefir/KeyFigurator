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

/// Build the shell invocation for a script. One definition, so a script tested
/// from the library runs through exactly the same shell as one fired by a key —
/// otherwise "it worked when I tested it" would not mean anything.
fn shell_for(script: &str) -> Command {
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

fn finish(mut cmd: Command, cwd: Option<&str>) -> Result<RunOutcome, RunError> {
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let out = cmd.output().map_err(|e| RunError::Spawn(e.to_string()))?;
    Ok(RunOutcome {
        status: out.status.code(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Run a script directly, with no binding and no index.
///
/// Deliberately separate from `run_binding`. That one takes an INDEX because
/// the BOARD sends indices, and the indirection is the whole security property:
/// a compromised board can only trigger something already approved, never
/// inject a command string. This takes the script itself and is reachable only
/// from the app's own UI — the board has no path to it. Testing a macro you
/// have not bound to a key yet is precisely the case that indirection was never
/// meant to prevent.
pub fn run_script(script: &str, cwd: Option<&str>) -> Result<RunOutcome, RunError> {
    let script = script.trim();
    if script.is_empty() {
        return Err(RunError::Empty);
    }
    finish(shell_for(script), cwd)
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
    let cmd = match b.script.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(script) => shell_for(script),
        None => {
            let (program, args) = b.command.split_first().ok_or(RunError::Empty)?;
            let mut c = Command::new(program);
            c.args(args);
            c
        }
    };
    finish(cmd, b.cwd.as_deref())
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

    /// The point of run_script: no binding, no index, no key. Testing a macro
    /// is what you do BEFORE deciding it deserves a key, so requiring one first
    /// had it backwards.
    #[test]
    fn runs_a_script_with_no_binding_at_all() {
        let out = run_script("echo untethered", None).expect("should run unbound");
        assert_eq!(out.status, Some(0));
        assert!(out.stdout.contains("untethered"), "stdout was {:?}", out.stdout);
    }

    /// Same shell as a bound macro, or "it worked when I tested it" would not
    /// carry over to the key. A multi-statement script only works in a shell.
    #[test]
    fn tested_script_uses_the_same_shell_as_a_bound_one() {
        let direct = run_script("echo one\necho two", None).unwrap();
        let bound = run_binding(
            &[HostBinding {
                index: 0,
                label: "s".into(),
                command: vec![],
                script: Some("echo one\necho two".into()),
                cwd: None,
            }],
            0,
        )
        .unwrap();
        assert_eq!(direct.stdout.trim(), bound.stdout.trim());
    }

    #[test]
    fn empty_script_errors_rather_than_spawning_a_shell() {
        assert!(matches!(run_script("   \n  ", None), Err(RunError::Empty)));
    }

    #[test]
    fn script_honours_cwd() {
        let tmp = std::env::temp_dir();
        #[cfg(windows)]
        let out = run_script("(Get-Location).Path", tmp.to_str()).unwrap();
        #[cfg(not(windows))]
        let out = run_script("pwd", tmp.to_str()).unwrap();
        let got = out.stdout.trim().to_lowercase();
        let want = tmp.to_string_lossy().trim_end_matches(['/', '\\']).to_lowercase();
        assert!(got.contains(&want), "cwd was {got:?}, wanted {want:?}");
    }

    #[test]
    fn unknown_index_errors() {
        let bindings = vec![echo_binding()];
        assert!(matches!(run_binding(&bindings, 9), Err(RunError::NoBinding(9))));
    }
}

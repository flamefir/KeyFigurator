//! Host command runner: the thing that makes a key able to run git/shell, or to
//! play back a recorded keystroke macro.
//!
//! Flow: key on the board sends a Raw HID RunHostCmd packet -> the app looks up
//! the HostBinding for that index -> performs it here. This is the piece Vial
//! cannot do (a keyboard can only type, not execute).
//!
//! Keystroke macros arrive here too, and for the same reason rather than a
//! different one: the board's macro engine cannot be given content over this
//! protocol, so the host performs the keys. See `keyplay` for why.
//!
//! SAFETY: only ever performs bindings the user configured in the app. The
//! board sends an *index*, never a command string or a key sequence, so a
//! compromised board can at worst trigger an already-approved binding, not
//! inject an arbitrary command.

use crate::model::{HostBinding, MacroAction};
use std::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error("no binding for index {0}")]
    NoBinding(u8),
    #[error("empty command")]
    Empty,
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("keystroke playback failed: {0}")]
    Playback(String),
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

/// Play a recorded keystroke macro on this host.
///
/// Reported as a `RunOutcome` like everything else so the UI's one result path
/// covers both macro kinds: `stdout` says what was performed, `stderr` carries
/// the steps that could not be, and a zero exit means it ran.
pub fn play_keys(actions: &[MacroAction]) -> Result<RunOutcome, RunError> {
    if actions.is_empty() {
        return Err(RunError::Empty);
    }

    #[cfg(target_os = "windows")]
    {
        let played = crate::keyplay::play(actions).map_err(RunError::Playback)?;
        Ok(RunOutcome {
            status: Some(0),
            stdout: format!("played {} keystroke step(s)", played.steps),
            stderr: played.warnings.join("\n"),
        })
    }
    // Not silently doing nothing: a keystroke macro that appears bound and
    // produces no keys is indistinguishable from the board-side bug this
    // whole path exists to route around.
    #[cfg(not(target_os = "windows"))]
    {
        let _ = actions;
        Err(RunError::Playback(
            "keystroke playback is only implemented on Windows".into(),
        ))
    }
}

pub fn run_binding(bindings: &[HostBinding], index: u8) -> Result<RunOutcome, RunError> {
    let b = bindings
        .iter()
        .find(|b| b.index == index)
        .ok_or(RunError::NoBinding(index))?;

    // Recorded keys are played here; a script goes through a shell; a command
    // list is spawned directly. The order is fixed so a binding edited from one
    // kind to another cannot keep doing the old thing — the frontend clears the
    // fields it is not using, and this is the second guard on that.
    //
    // All three come from bindings the user authored in this app. The board
    // only ever sends an index, so none of it can be steered from the keyboard
    // side.
    if !b.keys.is_empty() {
        return play_keys(&b.keys);
    }

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
        HostBinding {
            index: 0,
            label: "echo test".into(),
            command,
            script: None,
            keys: vec![],
            cwd: None,
        }
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
            keys: vec![],
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
                keys: vec![],
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

    /// Recorded keys win over a script left behind on the same binding, so a
    /// macro switched from shell to keystrokes cannot still run the old script.
    ///
    /// Deliberately built from a keycode with no host mapping: this asserts
    /// which BRANCH is taken, and a test that proves it by typing for real
    /// would fire keystrokes into whatever window the test runner happens to
    /// have focused.
    #[test]
    fn recorded_keys_take_precedence_over_a_script() {
        let b = HostBinding {
            index: 0,
            label: "converted".into(),
            command: vec![],
            script: Some("echo scripted".into()),
            keys: vec![MacroAction::Tap { key: "KC_NO".into() }],
            cwd: None,
        };
        let out = run_binding(&[b], 0).expect("should play rather than run the shell");
        assert!(!out.stdout.contains("scripted"), "stdout was {:?}", out.stdout);
        assert!(out.stdout.contains("keystroke"), "stdout was {:?}", out.stdout);
        // The unplayable step is reported rather than passed over in silence.
        assert!(out.stderr.contains("KC_NO"), "stderr was {:?}", out.stderr);
    }

    /// An empty `keys` is not a keystroke macro, it is a binding that has none
    /// — otherwise every shell binding would be routed into the player.
    #[test]
    fn an_empty_key_list_falls_through_to_the_script() {
        let mut b = echo_binding();
        b.keys = vec![];
        b.script = Some("echo scripted".into());
        let out = run_binding(&[b], 0).unwrap();
        assert!(out.stdout.contains("scripted"), "stdout was {:?}", out.stdout);
    }

    #[test]
    fn playing_nothing_errors_rather_than_reporting_success() {
        assert!(matches!(play_keys(&[]), Err(RunError::Empty)));
    }

    #[test]
    fn unknown_index_errors() {
        let bindings = vec![echo_binding()];
        assert!(matches!(run_binding(&bindings, 9), Err(RunError::NoBinding(9))));
    }
}

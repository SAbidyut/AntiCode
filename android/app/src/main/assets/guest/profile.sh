# AntiCode: runs for every login shell
export PATH="$HOME/.local/bin:$PATH"
# The folder picked in the app: the shell (and Antigravity / Claude Code) starts there.
if [ -n "$ANTICODE_CWD" ]; then
  cd -- "$ANTICODE_CWD" 2>/dev/null ||
    printf '\033[33mAntiCode: %s could not be opened — starting in %s\033[0m\n' "$ANTICODE_CWD" "$PWD" >&2
  unset ANTICODE_CWD
fi
# First plain shell: install the basic tools (agents are installed by their own buttons,
# or the first time you type 'agy' / 'claude').
case "$0" in */agy-start|*/claude-start) ;; *)
  if [ -n "$PS1" ] && [ -z "$AGY_SETUP_RUNNING" ] && [ ! -f "$HOME/.agy-terminal-base-done" ] && [ ! -f "$HOME/.agy-terminal-setup-done" ]; then
    # (Ctrl-C stops the setup, not the rest of the shell's start: its prompt still comes)
    trap : INT
    AGY_SETUP_RUNNING=1 /usr/local/bin/term-setup --auto
    trap - INT
  fi ;;
esac

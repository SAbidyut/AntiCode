# Agy Terminal: runs for every login shell
export PATH="$HOME/.local/bin:$PATH"
# First plain shell: install the basic tools (agents are installed by their own buttons,
# or the first time you type 'agy' / 'claude').
case "$0" in */agy-start|*/claude-start) ;; *)
  if [ -n "$PS1" ] && [ -z "$AGY_SETUP_RUNNING" ] && [ ! -f "$HOME/.agy-terminal-base-done" ] && [ ! -f "$HOME/.agy-terminal-setup-done" ]; then
    AGY_SETUP_RUNNING=1 /usr/local/bin/term-setup --auto
  fi ;;
esac

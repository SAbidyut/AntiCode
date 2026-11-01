# Agy Terminal: runs for every login shell
export PATH="$HOME/.local/bin:$PATH"
if [ -n "$PS1" ] && [ -z "$AGY_SETUP_RUNNING" ] && [ ! -f "$HOME/.agy-terminal-setup-done" ] && [ "$0" != "/usr/local/bin/agy-start" ]; then
  AGY_SETUP_RUNNING=1 /usr/local/bin/agy-setup
fi

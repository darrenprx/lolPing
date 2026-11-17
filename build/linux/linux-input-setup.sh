#!/bin/sh
# Gives the logged-in user access to the input devices and /dev/uinput, so lolPing can read the mouse and
# keyboard and pass them on under Wayland. Run as root (the app starts it through pkexec). Safe to run again.
set -eu

if [ "$(id -u)" != 0 ]; then
  echo "Run this as root: sudo sh $0" >&2
  exit 1
fi

RULES=/etc/udev/rules.d/70-lolping-input.rules
MODULES=/etc/modules-load.d/lolping-uinput.conf

# uaccess gives whoever is logged in at the desk access, with no group to join.
cat > "$RULES" <<'RULE'
SUBSYSTEM=="input", KERNEL=="event*", TAG+="uaccess"
KERNEL=="uinput", SUBSYSTEM=="misc", TAG+="uaccess", OPTIONS+="static_node=uinput"
RULE
chmod 644 "$RULES"

mkdir -p /etc/modules-load.d
echo uinput > "$MODULES"
chmod 644 "$MODULES"

modprobe uinput
udevadm control --reload-rules
# A failed trigger only means the new rules apply after the next login or reboot.
udevadm trigger --subsystem-match=input --subsystem-match=misc || true

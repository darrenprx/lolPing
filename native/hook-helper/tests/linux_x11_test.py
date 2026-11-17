#!/usr/bin/env python3
"""Real X11 grab/replay integration tests in a private Xvfb; never touch the user's display.
Needs Python 3, Xvfb and the built helper. Uses system X11/XTest via ctypes, no pip packages.
"""
import ctypes as C
import ctypes.util
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time

helper = Path(__file__).resolve().parents[1] / 'build/hook-helper'
# A Wayland session without device access and a missing display must stop cleanly, not claim readiness.
# Wayland goes to the evdev backend, which asks for setup when it can't open the devices (as on CI).
for overrides, code in [({'XDG_SESSION_TYPE': 'wayland'}, 'needsSetup'),
                        ({'XDG_SESSION_TYPE': 'x11', 'DISPLAY': ':65530', 'WAYLAND_DISPLAY': ''}, 'noAccess')]:
    env = {**os.environ, **overrides}
    if not env.get('WAYLAND_DISPLAY'): env.pop('WAYLAND_DISPLAY', None)
    r = subprocess.run([helper], input='', text=True, capture_output=True, env=env, timeout=5)
    assert r.returncode == 3 and code in r.stdout and '"ready"' not in r.stdout, (r.returncode, r.stdout, r.stderr)

x = C.CDLL(ctypes.util.find_library('X11'))
t = C.CDLL(ctypes.util.find_library('Xtst'))
def signature(lib, name, result, *args):
    f = getattr(lib, name); f.restype = result; f.argtypes = args
signature(x, 'XOpenDisplay', C.c_void_p, C.c_char_p)
signature(x, 'XDefaultRootWindow', C.c_ulong, C.c_void_p)
signature(x, 'XCreateSimpleWindow', C.c_ulong, C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong)
for name in ['XMapWindow', 'XDestroyWindow']:
    signature(x, name, C.c_int, C.c_void_p, C.c_ulong)
signature(x, 'XSelectInput', C.c_int, C.c_void_p, C.c_ulong, C.c_long)
signature(x, 'XSetInputFocus', C.c_int, C.c_void_p, C.c_ulong, C.c_int, C.c_ulong)
signature(x, 'XSync', C.c_int, C.c_void_p, C.c_int)
signature(x, 'XPending', C.c_int, C.c_void_p)
signature(x, 'XNextEvent', C.c_int, C.c_void_p, C.c_void_p)
signature(x, 'XKeysymToKeycode', C.c_uint, C.c_void_p, C.c_ulong)
signature(x, 'XCloseDisplay', C.c_int, C.c_void_p)
signature(t, 'XTestFakeKeyEvent', C.c_int, C.c_void_p, C.c_uint, C.c_int, C.c_ulong)
signature(t, 'XTestFakeButtonEvent', C.c_int, C.c_void_p, C.c_uint, C.c_int, C.c_ulong)
signature(t, 'XTestFakeMotionEvent', C.c_int, C.c_void_p, C.c_int, C.c_int, C.c_int, C.c_ulong)

server = subprocess.Popen([os.environ.get('XVFB', 'Xvfb'), '-displayfd', '1', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
proc = None
display = None
try:
    number = server.stdout.readline().strip()
    assert number.isdigit(), server.stderr.read()
    env = {**os.environ, 'DISPLAY': ':' + number, 'XDG_SESSION_TYPE': 'x11'}
    env.pop('WAYLAND_DISPLAY', None)
    display = x.XOpenDisplay(env['DISPLAY'].encode())
    assert display
    root = x.XDefaultRootWindow(display)
    window = x.XCreateSimpleWindow(display, root, 0, 0, 800, 600, 0, 0, 0)
    x.XSelectInput(display, window, 1 | 2 | 4 | 8)  # key/button press/release
    x.XMapWindow(display, window)
    x.XSetInputFocus(display, window, 1, 0)
    x.XSync(display, False)
    proc = subprocess.Popen([helper], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
    messages = queue.Queue()
    def reader():
        for line in proc.stdout: messages.put(json.loads(line))
    threading.Thread(target=reader, daemon=True).start()
    assert messages.get(timeout=5)['type'] == 'ready'
    def command(**values):
        proc.stdin.write(json.dumps(values) + '\n'); proc.stdin.flush(); time.sleep(.08)
    def key(sym, down):
        t.XTestFakeKeyEvent(display, x.XKeysymToKeycode(display, sym), down, 0); x.XSync(display, False); time.sleep(.04)
    def button(n, down):
        t.XTestFakeButtonEvent(display, n, down, 0); x.XSync(display, False); time.sleep(.04)
    def move(px, py):
        t.XTestFakeMotionEvent(display, -1, px, py, 0); x.XSync(display, False); time.sleep(.04)
    def received():
        time.sleep(.06); x.XSync(display, False)
        events=[]; event=(C.c_long*24)()
        while x.XPending(display):
            x.XNextEvent(display, C.byref(event)); events.append(event[0] & 0xffffffff)
        return events
    def emitted():
        time.sleep(.06); events=[]
        while not messages.empty(): events.append(messages.get_nowait())
        return events
    def types(): return [e['type'] for e in emitted()]
    ALT, CTRL, P, ESC = 0xffe9, 0xffe3, 0x70, 0xff1b
    command(type='config', trigger='alt', emoteTrigger='ctrl', clickPing=False, enabled=True)
    move(200,200); received(); emitted()
    button(1,True); button(1,False)
    assert received() == [4,5], 'plain click must reach the application exactly once'
    assert not emitted()
    key(ALT,True); received(); button(1,True); move(260,200); button(1,False); key(ALT,False)
    # A spot placed while the trigger key is held reports the key's release too (helper protocol 5).
    events=emitted(); assert [e['type'] for e in events] == ['wheelOpen','wheelMove','wheelRelease','triggerUp'], events
    assert events[-1]['wheel'] == 'ping', events
    assert not any(e in (4,5) for e in received()), 'wheel gesture leaked to application'
    key(ALT,True); received(); button(1,True); button(1,False); key(ALT,False)
    assert [e for e in received() if e in (4,5)] == [4,5], 'short trigger click must be replayed once'
    assert not emitted()
    key(CTRL,True); button(1,True); move(300,200); button(1,False); key(CTRL,False)
    events=emitted(); assert events[-2]['type']=='wheelRelease' and events[-2]['wheel']=='emote', events
    assert events[-1]=={'type':'triggerUp','wheel':'emote'}, events
    received()
    key(CTRL,True); key(ALT,True); key(P,True); key(P,False); key(ALT,False); key(CTRL,False)
    events=emitted(); assert events == [{'type':'toggled','enabled':False}], events
    assert len([e for e in received() if e == 2]) == 2, 'toggle key leaked to application'
    key(ALT,True); button(1,True); move(350,200); button(1,False); key(ALT,False)
    assert not emitted(); assert [e for e in received() if e in (4,5)] == [4,5]
    command(type='setEnabled',enabled=True)
    command(type='config',trigger='mouse4',emoteTrigger='off',enabled=True)
    button(8,True); move(400,200); button(8,False)
    assert types()==['wheelOpen','wheelMove','wheelRelease']; received()
    command(type='config',trigger='vk',triggerVk=0x47,emoteTrigger='off',enabled=True)
    key(0x67,True); button(1,True); move(450,200); button(1,False); key(0x67,False)
    events=emitted(); assert [e['type'] for e in events]==['wheelOpen','wheelMove','wheelRelease','triggerUp'], events
    assert received()==[], 'custom trigger must not type into the application'
    # A lone tap of a custom trigger is replayed when the key comes up, so it still types.
    key(0x67,True); key(0x67,False)
    assert not emitted(); r=received(); assert r==[2,3], ('a tapped custom trigger must type once', r)
    # Another key pressed while it is held sends it first; both keys then type, and nothing is left held.
    key(0x67,True); key(0x61,True); key(0x61,False); key(0x67,False)
    assert not emitted(); r=received(); assert r==[2,2,3,3], ('a held custom trigger must be typed before the next key', r)
    # Releasing the modifier before the mouse must replay down, then pass the real up.
    command(type='config',trigger='alt',emoteTrigger='off',enabled=True)
    key(ALT,True); received(); button(1,True); key(ALT,False); button(1,False)
    assert [e for e in received() if e in (4,5)] == [4,5], 'modifier-first click replay is unbalanced'
    assert not emitted()
    # Esc and right click cancel without leaking a click to the underlying application.
    key(ALT,True); received(); button(1,True); move(500,200); key(ESC,True); key(ESC,False); button(1,False); key(ALT,False)
    assert types()==['wheelOpen','wheelMove','cancel']
    assert received()==[3], 'Escape or mouse events leaked during cancellation'
    key(ALT,True); received(); button(1,True); move(550,200); button(3,True); button(1,False); button(3,False); key(ALT,False)
    assert types()==['wheelOpen','wheelMove','cancel']
    assert received()==[3], 'right click cancellation leaked to application'
    command(type='config',trigger='vk',triggerVk=0x47,emoteTrigger='off',enabled=True)
    command(type='suspend',on=True)
    key(0x67,True); key(0x67,False); button(1,True); button(1,False)
    assert received()==[2,3,4,5]; assert not emitted()
    command(type='shutdown'); assert proc.wait(timeout=5)==0
    button(1,True); button(1,False); assert received()==[4,5], 'shutdown left input grabbed'
    print('PASS: X11 input, click replay, ping/emote wheels, toggle, pause, mouse/custom triggers, suspend, shutdown and unsupported sessions')
finally:
    if proc and proc.poll() is None:
        proc.terminate(); proc.wait(timeout=5)
    if display: x.XCloseDisplay(display)
    server.terminate(); server.wait(timeout=5)

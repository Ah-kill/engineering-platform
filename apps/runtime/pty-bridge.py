#!/usr/bin/env python3
"""
PTY bridge for the browser terminal.

`docker exec -i` gives a process plain pipes, not a terminal, and the terminal size cannot
be changed from outside. This script runs inside the workspace container, starts a login
shell on a fresh pseudo-terminal and relays bytes between the PTY and its own stdio:

  stdin   framed messages from the API: 1 type byte, 4-byte big-endian length, payload
            b"d"  bytes typed by the developer, written to the PTY as they are
            b"r"  resize: 2-byte cols, 2-byte rows (big-endian), applied with TIOCSWINSZ
  stdout  raw PTY output, unframed

Every input byte travels inside a length-prefixed frame, so nothing the developer types
or pastes can ever be mistaken for a control message.

End of stdin (the browser went away) hangs up the shell and everything it started in the
foreground; the exit code is the shell's.

Usage: pty-bridge.py [COLS ROWS]
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

HEADER = struct.Struct(">cI")
RESIZE = struct.Struct(">HH")
MAX_FRAME = 1 << 20          # a single frame larger than this is a protocol error
MAX_PENDING = 4 << 20        # stop reading stdin while this much input waits for the shell
SHELL = ["bash", "-l"]


def clamp(value, low, high):
    return max(low, min(high, value))


def set_size(fd, cols, rows):
    winsize = struct.pack("HHHH", clamp(rows, 1, 500), clamp(cols, 2, 1000), 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def reap(pid):
    """The shell's wait status if it has exited, else None."""
    try:
        done, status = os.waitpid(pid, os.WNOHANG)
    except ChildProcessError:
        return 0
    return status if done else None


def hang_up(pid):
    """SIGHUP the shell's session, then SIGKILL whatever ignores it. Returns the wait status."""
    for sig, wait in ((signal.SIGHUP, 2.0), (signal.SIGKILL, 1.0)):
        status = reap(pid)
        if status is not None:
            return status
        try:
            os.killpg(pid, sig)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + wait
        while time.monotonic() < deadline:
            status = reap(pid)
            if status is not None:
                return status
            time.sleep(0.05)
    return reap(pid) or 0


def exit_code(status):
    code = os.waitstatus_to_exitcode(status)
    return 128 - code if code < 0 else code


def main():
    cols = int(sys.argv[1]) if len(sys.argv) > 2 else 80
    rows = int(sys.argv[2]) if len(sys.argv) > 2 else 24

    pid, master = pty.fork()
    if pid == 0:
        # Child: stdin/stdout/stderr are the PTY's slave side, and it is the controlling terminal.
        try:
            set_size(0, cols, rows)
            os.execvp(SHELL[0], SHELL)
        finally:
            os._exit(127)

    def on_signal(sig, _frame):
        hang_up(pid)
        os._exit(128 + sig)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)

    stdin = sys.stdin.buffer.fileno()
    stdout = sys.stdout.buffer.fileno()
    os.set_blocking(master, False)

    inbox = bytearray()    # framed bytes from the API, not yet parsed
    pending = bytearray()  # input waiting to be written to the PTY
    stdin_open = True
    status = None

    while True:
        readers = [master]
        if stdin_open and len(pending) < MAX_PENDING:
            readers.append(stdin)
        writers = [master] if pending else []
        try:
            readable, writable, _ = select.select(readers, writers, [], 1.0)
        except InterruptedError:
            continue

        if master in readable:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError as e:
                if e.errno != errno.EIO:
                    raise
                break  # EIO: the shell and everything holding the PTY are gone
            if data == b"":
                break
            if data:
                try:
                    write_all(stdout, data)
                except BrokenPipeError:
                    break

        if master in writable and pending:
            try:
                n = os.write(master, pending)
                del pending[:n]
            except BlockingIOError:
                pass
            except OSError:
                break

        if stdin in readable:
            chunk = os.read(stdin, 65536)
            if not chunk:
                stdin_open = False
                break
            inbox += chunk
            while len(inbox) >= HEADER.size:
                kind, length = HEADER.unpack_from(inbox)
                if length > MAX_FRAME:
                    sys.stderr.write("pty-bridge: frame too large\n")
                    stdin_open = False
                    break
                if len(inbox) < HEADER.size + length:
                    break
                payload = bytes(inbox[HEADER.size:HEADER.size + length])
                del inbox[:HEADER.size + length]
                if kind == b"d":
                    pending += payload
                elif kind == b"r" and length == RESIZE.size:
                    set_size(master, *RESIZE.unpack(payload))
                # Unknown frame types are ignored.
            if not stdin_open:
                break

        if not readable and not writable:
            status = reap(pid)
            if status is not None:
                break

    # The PTY can report EIO a moment before the shell becomes reapable.
    deadline = time.monotonic() + (1.0 if stdin_open else 0)
    while status is None:
        status = reap(pid)
        if status is not None or time.monotonic() >= deadline:
            break
        time.sleep(0.02)
    if status is None:
        status = hang_up(pid)
    try:
        os.close(master)
    except OSError:
        pass
    sys.exit(exit_code(status))


if __name__ == "__main__":
    main()

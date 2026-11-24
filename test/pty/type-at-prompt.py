"""Runs `siren login --password` in a pseudo-terminal and types at its prompts with no pause.

Usage: python3 type-at-prompt.py <node> <cli.js> <base url> <email> <password> <enter|ctrl-c>

The child is a shell that runs the command, prints its exit code, then prints
`stty -a`, so the terminal's mode after the command ended shows too. The
password goes in the instant `Password: ` arrives, the way a fast typist or a
password manager does it. With `ctrl-c`, the first four characters go in and
then Ctrl-C.

Prints one JSON line: what came back on the terminal between `Password: ` and
the next line break, whether any of the password came back anywhere, the exit
code, and whether `stty -a` shows `echo` on afterwards.
"""

import json
import os
import pty
import re
import select
import sys


def read_until(fd, wanted, seen, limit=15.0):
    """Reads from the terminal into `seen` until `wanted` is in it, or the limit passes."""
    while wanted not in seen:
        ready, _, _ = select.select([fd], [], [], limit)
        if not ready:
            raise SystemExit("timed out waiting for %r, saw %r" % (wanted, bytes(seen)))
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            raise SystemExit("the terminal closed before %r, saw %r" % (wanted, bytes(seen)))
        if not chunk:
            raise SystemExit("the terminal closed before %r, saw %r" % (wanted, bytes(seen)))
        seen.extend(chunk)


def main():
    node, cli, base, email, password, mode = sys.argv[1:7]
    script = '"$0" "$1" login --password --base-url "$2"; echo "EXIT=$?"; stty -a'
    pid, fd = pty.fork()
    if pid == 0:
        os.execv("/bin/sh", ["/bin/sh", "-c", script, node, cli, base])

    seen = bytearray()
    read_until(fd, b"Email: ", seen)
    os.write(fd, email.encode() + b"\r")
    read_until(fd, b"Password: ", seen)
    if mode == "ctrl-c":
        os.write(fd, password[:4].encode() + b"\x03")
    else:
        os.write(fd, password.encode() + b"\r")

    while True:
        ready, _, _ = select.select([fd], [], [], 20.0)
        if not ready:
            break
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        seen.extend(chunk)
    os.waitpid(pid, 0)

    text = bytes(seen).decode("utf-8", "replace")
    after = text.split("Password: ", 1)[1]
    line = re.split(r"\r?\n", after, maxsplit=1)[0]
    exit_code = re.search(r"EXIT=(\d+)", text)
    stty = text.split("EXIT=", 1)[1] if "EXIT=" in text else ""
    print(json.dumps({
        "afterPrompt": line,
        "passwordShown": password[:4] in after,
        "exit": int(exit_code.group(1)) if exit_code else None,
        "echoAfter": re.search(r"(?<![-\w])echo(?![\w])", stty) is not None,
    }))


main()

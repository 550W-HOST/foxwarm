"""Write reviewed release notes without their leading document title."""

import re
import sys
from pathlib import Path

notes = Path(sys.argv[1]).read_bytes()
# Match only a first-line ATX H1 and its following blank lines, without decoding.
body = re.sub(
    rb"\A {0,3}#(?:[ \t][^\r\n]*)?(?:\r?\n|$)(?:[ \t]*(?:\r?\n|$))*",
    b"",
    notes,
    count=1,
)
sys.stdout.buffer.write(body)

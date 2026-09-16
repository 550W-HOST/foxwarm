#!/usr/bin/env python3
import json, subprocess, sys
from pathlib import Path
from parity_compare import compare_case


def main():
    root = Path(__file__).parent
    corpus_path = root / 'parity-corpus.json'
    corpus = json.loads(corpus_path.read_text())
    ts = json.loads(subprocess.check_output([sys.executable, str(root / 'run-ts-parity.py')], text=True))
    cs = json.loads(subprocess.check_output([sys.argv[1] if len(sys.argv) > 1 else 'dotnet', 'run', '--project', str(root / 'Foxwarm.ConditionalMemory.Parity'), '--no-restore', '--', str(corpus_path)], text=True, cwd=root.parent.parent))
    if not (len(corpus) == len(ts) == len(cs)):
        raise SystemExit(f'count mismatch: corpus={len(corpus)} TS={len(ts)} C#={len(cs)}')
    counts = {'strict-semantic-json': 0, 'generated-json-semantic': 0, 'raw-text-exact': 0, 'native-diagnostic-compatible': 0, 'explicit-unsupported': 0}
    for case, left, right in zip(corpus, ts, cs):
        counts[compare_case(case, left, right)] += 1
    print('comparison ok: {} cases; strict-semantic-json={}, generated-json-semantic={}, raw-text-exact={}, native-diagnostic-compatible={}, explicit-unsupported={}'.format(len(corpus), counts['strict-semantic-json'], counts['generated-json-semantic'], counts['raw-text-exact'], counts['native-diagnostic-compatible'], counts['explicit-unsupported']))


if __name__ == '__main__':
    main()

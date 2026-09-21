#!/usr/bin/env python3
"""Finite reference-algebra checks only; not a Forge compiler or authorization test."""
from __future__ import annotations
import itertools
import json
from pathlib import Path
from typing import FrozenSet, Tuple

Atom = Tuple[str, str]
Atoms = FrozenSet[Atom]
State = Tuple[Atoms, Atoms]  # Preserve allows AND denials through composition.
ROOT = Path(__file__).resolve().parents[1]

def compose(a: State, b: State) -> State:
    return a[0] | b[0], a[1] | b[1]

def surface(s: State) -> Atoms:
    return s[0] - s[1]

def atoms(value: dict[str, list[str]]) -> Atoms:
    return frozenset((verb, field) for verb, fields in value.items() for field in fields)

def run_checks() -> dict:
    fixture = json.loads((ROOT / 'examples/expected-capability-surfaces.json').read_text())
    definitions = fixture['capabilities']
    memo: dict[str, State] = {}
    def resolve(name: str, visiting: frozenset[str] = frozenset()) -> State:
        if name in visiting:
            raise ValueError(f'Capability cycle at {name}')
        if name in memo:
            return memo[name]
        d = definitions[name]
        state = (atoms(d['allow']), atoms(d['deny']))
        for dep in d['includes']:
            state = compose(state, resolve(dep, visiting | {name}))
        memo[name] = state
        return state

    fixture_count = 0
    for name, expected in fixture['expected'].items():
        assert surface(resolve(name)) == atoms(expected), name
        fixture_count += 1
    assert 'SpecializedSupport' not in fixture['purpose_map']
    assert fixture['taxonomy']['SpecializedSupport']['extends'] == 'CustomerSupport'
    # No derivation from the purpose taxonomy into authority is performed.
    fixture_count += 1

    universe = (('read', 'a'), ('read', 'b'), ('actions', 'export'))
    subsets = [frozenset(x for i, x in enumerate(universe) if mask & (1 << i))
               for mask in range(1 << len(universe))]
    states = list(itertools.product(subsets, subsets))
    counts = {'idempotence': 0, 'commutativity': 0, 'associativity': 0,
              'denial_preservation': 0, 'runtime_attenuation': 0}
    for a in states:
        assert compose(a, a) == a
        counts['idempotence'] += 1
        for b in states:
            assert compose(a, b) == compose(b, a)
            counts['commutativity'] += 1
            assert not (surface(compose(a, b)) & (a[1] | b[1]))
            counts['denial_preservation'] += 1
            for c in states:
                assert compose(compose(a, b), c) == compose(a, compose(b, c))
                counts['associativity'] += 1
        for restriction in subsets:
            assert surface(a) & restriction <= surface(a)
            counts['runtime_attenuation'] += 1

    return {
        'status': 'passed', 'scope': 'finite Python set-algebra reference model',
        'fixture_checks': fixture_count, 'universe_atoms': len(universe),
        'enumerated_states': len(states), 'property_checks': counts,
        'not_established': [
            'Correctness of a Forge parser/compiler or generated TypeScript',
            'Gatekeeper/OPA authorization or real runtime isolation',
            'Any live database, deployment, compliance or conformance result'
        ]
    }

if __name__ == '__main__':
    print(json.dumps(run_checks(), indent=2))

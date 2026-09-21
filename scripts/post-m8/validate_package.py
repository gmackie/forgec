#!/usr/bin/env python3
"""Validate planning artifact consistency, never report planned scenarios as passed."""
from __future__ import annotations
import hashlib
import json
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_capability_algebra import run_checks


def load(path: str) -> dict:
    return json.loads((ROOT / path).read_text())


def acyclic(nodes: dict[str, list[str]]) -> None:
    seen: set[str] = set()
    active: set[str] = set()
    def visit(node: str) -> None:
        if node in active:
            raise AssertionError(f'dependency cycle at {node}')
        if node in seen:
            return
        active.add(node)
        for dep in nodes[node]:
            assert dep in nodes, f'unknown dependency: {dep}'
            visit(dep)
        active.remove(node)
        seen.add(node)
    for node in nodes:
        visit(node)


def main() -> None:
    json_files = list(ROOT.rglob('*.json'))
    for path in json_files:
        json.loads(path.read_text())
    toml_files = list(ROOT.rglob('*.toml'))
    for path in toml_files:
        with path.open('rb') as stream:
            tomllib.load(stream)

    base_tasks = load('specs/baseline-backlog.json')['items']
    base_tests = load('specs/baseline-parity-tests.json')['scenarios']
    tasks = load('specs/backlog.json')['items']
    tests = load('specs/extension-conformance.json')['scenarios']
    milestones = load('specs/milestones.json')['milestones']
    assert len(base_tasks) == 26 and len(base_tests) == 75
    assert len(tasks) == 65 and len(tests) == 104 and len(milestones) == 13
    tids = {x['id'] for x in tasks}
    sids = {x['id'] for x in tests}
    mids = {x['id'] for x in milestones}
    assert len(tids) == len(tasks) and len(sids) == len(tests)
    assert tids == {f'FORGE-{i:03d}' for i in range(27, 92)}
    assert sids == {f'PAR-{i:03d}' for i in range(76, 180)}
    assert mids == {f'M{i}' for i in range(9, 22)}
    mg = {x['id']: x['dependencies'] for x in milestones}
    acyclic(mg)
    # Expand milestone gate requirements to all tickets in that milestone.
    by_m = {m: [t['id'] for t in tasks if t['milestone'] == m] for m in mids}
    graph: dict[str, list[str]] = {}
    for t in tasks:
        assert t['milestone'] in mids and t['status'] == 'planned'
        assert t['test_ids'] and set(t['test_ids']) <= sids
        assert t['scope'] and t['acceptance'] and t['deliverables']
        dependencies: list[str] = []
        for d in t['dependencies']:
            if d.endswith(':gate'):
                assert d[:-5] in mids
                dependencies.extend(by_m[d[:-5]])
            else:
                assert d in tids
                dependencies.append(d)
        graph[t['id']] = dependencies
    acyclic(graph)
    for case in tests:
        assert case['primary_ticket'] in tids
        assert case['status'] == 'specified-not-run'
        assert all(case.get(k) for k in ['given', 'when', 'expected', 'required_profiles'])
    for m in milestones:
        assert set(m['ticket_ids']) == set(by_m[m['id']])
    for item in load('specs/traceability.json')['requirements']:
        assert item['milestone'] in mids

    # No remote JSON schema resolution is required for this fixture.
    schema = load('schemas/capability-atoms.schema.json')
    schema_validation = 'not-run: jsonschema not installed'
    try:
        from jsonschema import Draft202012Validator
        Draft202012Validator.check_schema(schema)
        Draft202012Validator(schema).validate(load('examples/flattened-capability.json'))
        schema_validation = 'passed'
    except ImportError:
        pass

    plan = (ROOT / 'IMPLEMENTATION_PLAN.md').read_text()
    assert len(re.findall(r'^## \d+\.', plan, re.M)) == 25
    assert plan.count('```') % 2 == 0
    assert '\ufffd' not in plan
    sources = load('specs/sources.json')['sources']
    referenced = set(re.findall(r'\[(R\d+)\]', plan))
    assert referenced <= {s['id'] for s in sources}
    assert all(f'### {m} —' in plan for m in mids)
    assert all(tid in plan for tid in tids)

    result = {
        'status': 'passed', 'scope': 'planning-package validation only',
        'baseline_tasks': len(base_tasks), 'new_tasks': len(tasks),
        'baseline_scenario_specifications': len(base_tests),
        'new_scenario_specifications': len(tests),
        'total_scenario_specifications': len(base_tests)+len(tests),
        'milestones': len(milestones), 'json_files_parsed': len(json_files),
        'toml_files_parsed': len(toml_files),
        'dependency_dags': 'passed', 'id_cross_references': 'passed',
        'draft_capability_json_schema': schema_validation,
        'capability_algebra': run_checks(),
        'not_run': ['Forge compilation', 'TypeScript/Effect type checking',
                    '179 Forge conformance scenarios', 'Cloud deployments or Terraform/CDK/Alchemy execution',
                    'Authorization penetration tests', 'Legal/compliance assessment'],
        'plan_sha256': hashlib.sha256(plan.encode()).hexdigest(),
        'plan_word_count': len(plan.split())
    }
    (ROOT / 'ARTIFACT_CHECKS.json').write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()

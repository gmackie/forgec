# Lifecycle inference and diagnostics

```forge
lifecycle status {
  initial Draft
  terminal Completed
  terminal Cancelled
  submit: Draft -> Submitted
  approve: Submitted -> Approved
  complete: Approved -> Completed
  cancel: Draft | Submitted | Approved -> Cancelled
    input { reason : text length 1..500 }
}
```

## Elaboration

1. **State set** = every identifier appearing as a source, target, `initial`,
   or `terminal`. Order of first appearance is preserved for the synthesized
   enum; wire values are the state names verbatim.
2. **Synthesized declarations**: field `status : <Resource>.Status` (server
   owned, excluded from create/update inputs), enum `<Resource>.Status`,
   commands `<Resource>.status.<action>` with input = the transition's `input`
   block (or unit) and `expectedVersion`.
3. **Initial**: exactly one `initial` is required (E-LC-001). Creation sets
   it. An `initial` state that has incoming edges is allowed but warned
   (W-LC-010) because re-entering the initial state is usually a modelling
   error.
4. **Terminal**: a `terminal` state with an outgoing edge is an error
   (E-LC-002).

## Diagnostics

| code | condition |
| --- | --- |
| E-LC-001 | no `initial`, or more than one |
| E-LC-002 | outgoing transition from a `terminal` state |
| E-LC-003 | duplicate action name |
| E-LC-004 | state unreachable from `initial` |
| E-LC-005 | state with no path to any `terminal` (warning W-LC-005 if the lifecycle declares no terminal at all) |
| E-LC-006 | same action name declared with incompatible `input` blocks |
| E-LC-007 | a state name is not a valid enum member identifier |
| W-LC-011 | a state name is within edit distance 1 of another state (`Aproved` vs `Approved`) — inferred state sets cannot prove intent |
| E-LC-020 | transition sources overlap in a way that makes the action ambiguous (same action, same source, two targets) |

Transitions are checked at commit inside the guarded mutation: the predicate
includes `status IN <sources>` and `version = expected`. A transition to the
same state is not allowed to be declared (`Draft -> Draft` is E-LC-021).

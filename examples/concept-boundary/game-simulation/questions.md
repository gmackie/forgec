# Falsifiable questions

1. Is the stable accepted-input order independent of network arrival scheduling after SealInputs commits its cutoff? Test duplicates, equal target ticks and reconnects.
2. Can a restarted AdvanceWorld publish the same tick twice or skip its predecessor digest? Logical ownership alone is not an implementation fencing mechanism.
3. Does replay hold across CPU architecture, compiler flags, physics solver versions and thread counts? If not, narrow the supported envelope instead of weakening digest equality silently.
4. Is a missed 20 ms tick a delayed real-time response or permission to skip logical ticks? This fixture requires preserving logical order; overrun policy needs an executable realization.
5. Can a predicted client result enter WorldState without authoritative input admission? The graph says no; integration tests must enforce it.
6. Can the replay facet share provenance vocabulary with scientific workflows while keeping exact versus tolerance-based equivalence distinct?

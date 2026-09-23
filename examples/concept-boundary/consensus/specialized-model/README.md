# Executed bounded TLA+ handoff

`BoundedQuorum.tla` and `.cfg` are original corpus artifacts. The official TLA+ release jar was downloaded outside the repository from the URL in verification.json. The receipt pins its SHA-256 because its reported build version differs from a simple release number. Java 26.0.1 executed TLC successfully: 107 generated / 41 distinct states, depth five, no outstanding states; TypeOK, Agreement and Validity held for three voters and two values.

From this directory, with the recorded jar available:

```sh
java -cp /tmp/forge-boundary-tla2tools-1.8.0.jar tlc2.TLC -workers 1 -metadir /tmp/forge-boundary-tlc-recheck -config BoundedQuorum.cfg BoundedQuorum.tla
```

CheckProtocol's `#input:request` and `#output:request` carry VerificationRequest to TLC. RecordVerification's `#input:report` receives VerificationReport and emits `#output:record` / `#output:recorded`. The request must bind both source and configuration hashes; the report must match them and the tool identity. `verification.json` is a concrete execution receipt, not a runtime report fixture or an implemented adapter. Empty counterexampleDigest denotes no trace only for a completed successful run; canceled and inconclusive runs need explicit statuses.

A temporary negative control removed the write-once voting guard. With the original invariant list, TLC found a Validity violation. Checking TypeOK and Agreement then found an Agreement counterexample (366 generated / 67 distinct states before stopping). The checked-in model/config are unchanged; this mutation shows the safety checks detect a meaningful weakening.

Limitations: one slot, fixed membership, no crashes, messages, elections or recovery. Indefinite stuttering is allowed. Deadlock checking is disabled and no liveness formula is checked. Majority intersection explains this bounded abstraction; no relationship to production consensus code has been proven. The stable seam permits a richer model later without adding temporal-logic nodes to ConceptIR.

An offline digest-checking runner is also supplied: `TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar sh verify.sh`. It creates temporary outputs outside the fixture and never downloads tools.

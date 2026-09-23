# Questions and checks before an executable twin

- Can an exported FMU's modelDescription.xml prove connector name/unit/causality agreement with the SSD? The current static source/XML check is insufficient.
- What positivity bounds and identification evidence justify C and G, and what sensor uncertainty applies? The representative equation supplies none of that evidence.
- Which FMI mode, solver, tolerances and communication policy does a real run require? A generic SimulationMaster label cannot choose them.
- What observable tolerance and event alignment define “same result” across workers? Pinning bytes alone does not define numerical equivalence.
- How should measured observations invalidate a calibration without rewriting prior simulated trajectories? Preserve both histories and make reconciliation a distinct process.
- Does generic provenance plus an artifact package suffice across scientific experiments and simulation? Only promote the replay facet after testing both comparison policies.

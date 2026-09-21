# Machine-readable work specification

`baseline-backlog.json` and `baseline-parity-tests.json` are preserved from the previous planning package: 26 tasks and 75 scenarios.

`backlog.json` adds 65 tasks, FORGE-027–091. A dependency such as `M12:gate` means all completion requirements for that milestone must pass, not simply that its source files exist. The conservative task ordering may be parallelized after shared interface contracts are frozen.

`milestones.json` defines 13 completion gates, M9–M21. `extension-conformance.json` adds 104 scenario specifications, PAR-076–179. Every scenario is marked `specified-not-run`; every implementation task is `planned`.

`traceability.json` maps new features to baseline functionality and milestones. `sources.json` provides external technical/legal reference sources, while `baseline-provenance.json` identifies the actual input artifacts.

Future implementation deliverable paths in backlog entries are intended repository paths, not claims those files already exist inside this planning package. The package's actual draft examples and helper scripts are listed in its root README.

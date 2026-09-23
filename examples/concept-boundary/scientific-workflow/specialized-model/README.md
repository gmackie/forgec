# CWL/HPC and numerical-model handoff

`sweep-interface.txt` is a non-executable CWL/Slurm interface sketch for ExecuteMember. It describes typed job submission/result ports and checkpoint/provenance constraints, not a valid CWL document or sbatch script. `numerical-envelope.json` names the separate numerical reproducibility and acceptance obligations consumed when CollectExperiment interprets artifacts.

No job was scheduled, RO-Crate emitted, PDE integrated or comparison executed. An implementation should pin real CWL/tool descriptions, executable/container and dataset manifests, then preserve scheduler attempts and output hashes independently of successful collection. The corpus makes no bitwise or tolerance-based reproducibility claim; the pinned comparison policy would decide which evidence is required.

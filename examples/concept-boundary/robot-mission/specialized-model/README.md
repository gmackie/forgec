# Controller/planner handoff

`controller-interface.txt` is an interface sketch, not ROS, SCADE, Modelica or a certified controller implementation. It names the precise AssessPlan and AdvanceMission ports and the trajectory/command/receipt obligations. The ConceptIR graph stores model and trajectory digests; an actual deployment must resolve digest-pinned planner/controller artifacts, reject coordinate-frame mismatch, and attach measured/analyzed evidence.

No simulator, optimizer, WCET analyzer or robot was run. Ptolemy II is cited to identify differing execution semantics, not to claim its continuous-time director has executed this sketch. Logical process ownership remains unchanged by CPU/GPU/controller allocation.

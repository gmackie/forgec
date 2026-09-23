# Executed single-clock RTL seam

`elastic_stage.sv` implements one 8-bit ready/valid slot. `elastic_stage_tb.sv` exercises fill, prolonged stall, blocked input, consume/replace, full-rate transfer and drain. Its scoreboard checks order, occupancy and conservation; a separate assertion checks stalled output stability. Synchronous reset clears the slot and discards pending data. The test begins after reset, so it does not assert cross-reset conservation.

Run from this directory:

```sh
iverilog -g2012 -s elastic_stage_tb -o /tmp/forge-boundary-elastic.vvp elastic_stage.sv elastic_stage_tb.sv
vvp /tmp/forge-boundary-elastic.vvp
```

Icarus Verilog 13.0 development build reported PASS: accepted=3, emitted=3, maxOccupancy=1. Input digests, command and precise limits appear in verification.json. A temporary negative control forced in_ready high; the test failed with invalid occupancy at time 45. The checked-in RTL remained unchanged.

ValidatePipeline `#input:request` and `#output:request` bind PipelineRequest to HDLToolchain. RecordPipelineValidation consumes `#input:report`, producing `#output:record` and `#output:recorded`. A real adapter must correlate the request digest and source/test/constraint identities before accepting a report. This directory supplies evidence, not that adapter.

The stage is illustrative RTL, not an SDF scheduler or an asynchronous FIFO. Directed simulation does not establish exhaustive safety, synthesis equivalence, physical timing, metastability handling or CDC correctness. One accepted token per firing and a one-slot capacity are concrete local assumptions; changing rates, buffering or clock domains invalidates this test's scope.

An offline digest-checking runner is also supplied: `sh verify.sh`. It creates temporary outputs outside the fixture and never downloads tools.

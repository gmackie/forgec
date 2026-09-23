# Questions and promotion tests

- Does changing the 5000 us period or 2000 us deadline change admissible behavior? Yes: therefore these are proposed L0 requirements, although timer and scheduler mechanisms remain L1/L2.
- What starts and ends the deadline? Scheduled release to command acceptance at the I/O boundary, with clock/jitter/error assumptions still owed by the realization. A process-return timestamp is insufficient.
- Can the existing Process carry the responsibility? Yes, but its external Tick activation does not assert a fixed frequency or synchronous evaluation order.
- Is a mode a new kernel node? No. Begin with domain data, then explicit transition/recovery obligations and a shared pattern if multiple domains need it.
- What would justify a common timing facet? Flight-control, packaging-line and medical-device all require release/deadline/budget constraints independent of scheduler choice. They do not share a universal safe mode or control law.
- Where does the model stop? Verified reactive state-machine execution, motor/flow dynamics, alarm effectiveness, dose accuracy and clinical safety arguments. Matching ports cannot import those execution or physical laws.
- What evidence is missing? Measured or soundly bounded WCET, scheduling/bus analysis, specialized-model verification, hardware-in-loop testing and domain hazard review.
- How is safety separated from authorization? Operator/clinical approval authority is an integration policy; control safety constraints neither grant access nor prove that an authorized command is physically safe.
